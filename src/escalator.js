/**
 * v41pro-escalator —— 卡住探测 + 模型升级。
 *
 * 这是整个包里唯一一个直接动「能力」的插件：它不教模型怎么变聪明，而是
 * 在它证明自己卡住之后，把那一步交给更强的模型（默认 deepseek-v4-pro），
 * 然后自动降回来。
 *
 * 三条硬约束，写在最前面：
 *  1. **任何监听器都不允许抛错**。agent loop 上的一个异常会让整轮对话失败，
 *     插件的收益远小于它的风险。
 *  2. **升级必须可预算**。设有 maxEscalations / escalateSteps / cooldownSteps
 *     三道闸，避免 flash ⇄ pro 反复横跳烧钱。
 *  3. **只用公开的模型选择 API**，provider 沿用当前选择。若某个 provider 不
 *     认识目标模型，升级会被探测并自动关闭（见 resolveProModel）。
 *
 * 契约基线：deepseek-harness 0.2.2-rc.3。
 *
 * 从 0.2.2-rc.2 起 `agent/request` 瀑布被删除——插件不能再逐请求改写
 * `LlmCallConfig`。替代者是持久化的模型选择：
 *
 *   agent.model.current()            → Readonly<ModelSelection> | undefined
 *   agent.model.select(selection)    → 把选择记进 Session（`model/selection`），
 *                                      从**下一步**开始生效，直到下次选择
 *
 * 所以升级的时序变成：第 N 步的工具结果里 select(pro) → 第 N+1 步起用 pro；
 * 到第 N+escalateSteps 步的 pre-step 再 select(原选择) → 后面回到原模型。
 * harness 自己会给模型注入一条「model changed」提示，本包不重复造轮子。
 *
 * 事件契约（来自 packages/core/agent 与 packages/core/tools）：
 *  - `tools/post-execute(exec, result, next)`  → waterfall，可附加 additionalContexts
 *  - `agent/pre-step(payload, next)`           → waterfall，返回 PreStepDecision
 *  - `agent/turn-stopping(payload)`            → serial，可 agent.steer() 续命
 *  - `agent/assistant-stream(payload)`         → emit，流式增量
 */

import { makeLogger, num, str } from './core/config.js'
import { createAgentStore } from './core/state.js'
import { createNotice } from './core/message.js'
import { canonicalize, extractPath, safe } from './core/util.js'
import { assessCommandResult, failureFingerprint } from './core/evidence.js'
import { adaptReasoning } from './core/capabilities.js'
import {
  escalatedNotice,
  gentleReminder,
  handoffNotice,
  signalLines,
  strongReminder,
} from './core/text.js'

export const name = 'v41pro-escalator'

/** 没有 tools 就没有工具调用可观测，插件应当静默休眠。 */
export const inject = ['tools']

/** 默认配置。cordis 会把 bundle patch 里的 config 合并进来。 */
export const DEFAULTS = {
  /** 'off' 只观测不干预；'advise' 只注入提醒；'escalate' 允许切换到 proModel。 */
  mode: 'advise',
  /** 升级目标模型。空字符串表示禁用模型升级。 */
  proModel: 'deepseek-v4-pro',
  /** 升级时同时覆盖的推理档位（'off' | 'low' | 'high' | 'max'）。空字符串表示不改。 */
  proReasoningEffort: '',
  /** 文案语言：'zh' | 'en'。 */
  language: 'zh',

  /** 触发干预的总分阈值。 */
  threshold: 3,
  /** 同一工具+同一参数连续多少次算「重复」。 */
  repeatThreshold: 4,
  /** 连续多少次工具失败算「卡住」。 */
  failureThreshold: 3,
  /** 同一文件被改多少次算「反复横跳」。 */
  editRepeatThreshold: 4,
  /** 多少步没有一次成功的工具调用算「漂移」。 */
  noProgressSteps: 8,
  /** 两次干预之间至少间隔多少步。 */
  cooldownSteps: 3,
  /** 一轮对话内最多干预几次，超过就交回用户。 */
  maxInterventions: 2,
  /** 全程最多升级几次。 */
  maxEscalations: 2,
  /** 一次升级持续多少步。 */
  escalateSteps: 4,
  /** 哪些工具算「写文件」。按名称正则匹配。 */
  editTools: 'write|edit|patch|apply|create_file|notebook',
  /** 自述不确定的措辞。命中即视为强信号。 */
  doubtPattern: '不确定|不清楚|无从下手|卡住|好像不行|I(?:\'| a)?m not sure|I am not sure|I(?:\'| a)?m stuck|unclear how',
}

const STRONG_SIGNAL_WEIGHT = 3
const WEAK_SIGNAL_WEIGHT = 1

/** 逐条判断当前是否「卡住」，返回证据列表（每条带权重）。 */
export function evaluate(state, cfg) {
  /** @type {Array<{ kind: string, detail: string, weight: number }>} */
  const signals = []

  if (state.repeat >= cfg.repeatThreshold) {
    signals.push({
      kind: 'repeat',
      detail: `同一工具与同一参数连续 ${state.repeat} 次（\`${state.lastTool}\`）`,
      weight: STRONG_SIGNAL_WEIGHT,
    })
  }
  if (state.repeatedFailure >= cfg.repeatThreshold) {
    signals.push({
      kind: 'repeatedFailure',
      detail: `相同工具、参数与失败摘要已出现 ${state.repeatedFailure} 次`,
      weight: STRONG_SIGNAL_WEIGHT,
    })
  }
  if (state.consecutiveFailures >= cfg.failureThreshold) {
    signals.push({
      kind: 'failure',
      detail: `连续 ${state.consecutiveFailures} 次工具调用失败`,
      weight: STRONG_SIGNAL_WEIGHT,
    })
  }
  if (state.selfDoubt) {
    signals.push({
      kind: 'doubt',
      detail: '回复里出现了「不确定 / 卡住」一类措辞',
      weight: STRONG_SIGNAL_WEIGHT,
    })
  }

  const hottest = hottestEdit(state)
  if (hottest && hottest.count >= cfg.editRepeatThreshold) {
    signals.push({
      kind: 'edit',
      detail: `\`${hottest.path}\` 已被反复改动 ${hottest.count} 次`,
      // 超过两倍阈值说明持续原地编辑，可以单独构成卡住证据。
      weight: hottest.count >= cfg.editRepeatThreshold * 2 ? STRONG_SIGNAL_WEIGHT : WEAK_SIGNAL_WEIGHT,
    })
  }
  const stalled = state.step - state.lastProgressStep
  if (state.step > 0 && stalled >= cfg.noProgressSteps) {
    signals.push({
      kind: 'drift',
      detail: `已经 ${stalled} 步没有一次成功的工具调用`,
      weight: stalled >= cfg.noProgressSteps * 2 ? STRONG_SIGNAL_WEIGHT : WEAK_SIGNAL_WEIGHT,
    })
  }

  return signals
}

/** 改动次数最多的那个文件。 */
function hottestEdit(state) {
  let best = null
  for (const [path, count] of state.edits) {
    if (!best || count > best.count) best = { path, count }
  }
  return best
}

/** 该 agent 的干预状态。 */
function createState() {
  return {
    turn: 0,
    step: 0,
    lastKey: '',
    lastTool: '',
    repeat: 0,
    consecutiveFailures: 0,
    lastFailureKey: '',
    repeatedFailure: 0,
    /** @type {Map<string, number>} */
    edits: new Map(),
    lastProgressStep: 0,
    lastInterventionStep: -1_000_000,
    interventions: 0,
    escalations: 0,
    escalatedUntilStep: -1,
    /** 本步捕获的模型选择（来自 agent/pre-step 的 payload.modelSelection）。 */
    selection: null,
    /** 升级前记下的原选择，用于降回。 */
    previousSelection: null,
    /** 当前升级目标选择，用于判断期间有没有被用户手动改过。 */
    escalatedSelection: null,
    /** 无法使用公开模型选择 API 时只警告一次。 */
    escalationUnavailable: false,
    pendingHandoff: false,
    /** 最近一段回复/思考的尾巴，用于自述不确定检测。 */
    speechTail: '',
    chunkCounter: 0,
    selfDoubt: false,
  }
}

/**
 * @param {import('./core/types.js').PluginContext} ctx
 * @param {Record<string, unknown>} [rawConfig]
 */
export function apply(ctx, rawConfig = {}) {
  const logger = makeLogger(ctx, name)
  const cfg = normalize(rawConfig, logger)
  if (cfg.mode === 'off') {
    logger.info('mode=off，只登记不干预')
  }

  const states = createAgentStore(createState)

  /** proModel 能力缓存：provider → { ok, efforts, defaultEffort }。 */
  const proModelCache = new Map()

  /**
   * 探测 provider 上的 proModel：存在与否，以及它接受哪些推理档位。
   *
   * harness 对不支持的显式 effort 是**直接 reject**、不做钳制或别名
   * （llm 服务 resolveModelInfo 的文档原话）。所以「升级时顺手写死
   * reasoningEffort: high」是有风险的 —— 用户一旦关掉思考模式，这个请求会在
   * 发起任何 I/O 之前就失败。这里改为先查能力，再决定写什么。
   *
   * 拿不到 llm 服务时 efforts = null，表示「无法验证」。
   * 探测抛错 → ok=false，该 provider 后续不再尝试升级。
   */
  async function resolveProModel(provider) {
    if (!cfg.proModel) return { ok: false, efforts: null, defaultEffort: null }
    const cached = proModelCache.get(provider)
    if (cached) return cached

    const llm = /** @type {any} */ (ctx).llm
    const resolve = typeof llm?.resolveModelInfo === 'function'
      ? (route, model) => llm.resolveModelInfo(route, model)
      : null
    if (!resolve) {
      // 无法验证目标能力时 fail-closed：保留提醒，不切换模型。
      const entry = { ok: false, efforts: null, defaultEffort: null }
      proModelCache.set(provider, entry)
      logger.warn('当前上下文没有 llm.resolveModelInfo，模型升级已关闭')
      return entry
    }

    try {
      const info = await resolve(provider, cfg.proModel)
      const ok = info !== undefined && info !== null
      const rawEfforts = info?.reasoning?.efforts
      const efforts = Array.isArray(rawEfforts)
        ? rawEfforts.map(entry => (entry && typeof entry.id === 'string' ? entry.id : '')).filter(Boolean)
        : null
      const defaultEffort = typeof info?.reasoning?.defaultEffort === 'string' ? info.reasoning.defaultEffort : null
      const entry = { ok, efforts: ok ? efforts : null, defaultEffort: ok ? defaultEffort : null }
      proModelCache.set(provider, entry)
      if (!ok) logger.warn(`provider "${provider}" 上没有模型 "${cfg.proModel}"，模型升级已关闭`)
      return entry
    } catch (error) {
      const entry = { ok: false, efforts: null, defaultEffort: null }
      proModelCache.set(provider, entry)
      logger.warn(`无法解析 "${provider}" 上的 "${cfg.proModel}"，模型升级已关闭：`, error instanceof Error ? error.message : error)
      return entry
    }
  }

  /**
   * 决定升级后写不写 reasoningEffort。
   * @returns {{ set: boolean, value?: string }}
   *   set=true 表示用 value（可能为空串，代表删除该字段）。
   */
  function pickEffort(capability, current) {
    const configured = cfg.proReasoningEffort
    const allowed = capability.efforts

    // 无法验证模型能力：只信显式配置，否则保持原样（不写 = 不改）。
    if (!allowed) {
      if (configured) return { set: true, value: configured }
      return { set: false }
    }

    if (configured && allowed.includes(configured)) return { set: true, value: configured }
    const adapted = configured === 'off'
      ? undefined
      : adaptReasoning({ reasoning: { efforts: allowed.map(id => ({ id })) } }, configured)
    if (adapted && adapted !== 'off') return { set: true, value: adapted }
    // 配置的档位不可用（例如用户关掉了思考模式）→ 尝试沿用当前档位。
    if (current && allowed.includes(String(current))) return { set: true, value: String(current) }
    // 都不行 → 显式删除，交给适配器自己取默认值。
    return { set: true, value: '' }
  }

  // ── 观测：工具调用结果 ────────────────────────────────────────────────────
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    const notice = await safeAsync(async () => {
      const agent = /** @type {any} */ (exec).agent
      if (!agent) return undefined
      const state = states.get(agent)
      observe(state, exec, result, cfg)
      return await intervene(agent, state, cfg, logger)
    }, error => logger.warn('post-execute 观测失败：', error))
    if (!notice) return downstream
    return withContext(downstream, notice)
  })

  // ── 步边界：维护 step/turn、捕获选择、到点降回原模型 ──────────────────────
  ctx.on('agent/pre-step', async (payload, next) => {
    safe(() => {
      const state = states.get(payload.agent)
      const previousTurn = state.turn
      state.turn = payload.turn
      state.step = payload.step
      // rc.3 把本步的固定选择放在 payload.modelSelection 上；记下来供升级用。
      if (payload.modelSelection && typeof payload.modelSelection.provider === 'string') {
        state.selection = { ...payload.modelSelection }
      }
      if (payload.turn !== previousTurn) {
        state.interventions = 0
        state.pendingHandoff = false
      }
      // 用户新插话 = 语境变了，重复链与失败计数不再代表「卡住」。
      const hasUserInput = Array.isArray(payload.messages)
        && payload.messages.some(message => message?.source?.kind === 'user')
      if (hasUserInput) {
        state.repeat = 0
        state.lastKey = ''
        state.consecutiveFailures = 0
        state.lastFailureKey = ''
        state.repeatedFailure = 0
      }
      restoreIfDue(payload.agent, state, payload.step, logger)
    }, error => logger.warn('pre-step 观测失败：', error))
    return next()
  })

  // ── 回合收尾：接手人工交接 ────────────────────────────────────────────────
  ctx.on('agent/turn-stopping', ({ agent }) => {
    safe(() => {
      const state = states.get(agent)
      if (!state.pendingHandoff) return
      state.pendingHandoff = false
      state.interventions = 0
      state.lastInterventionStep = state.step
      agent.steer(createNotice({
        kind: 'v41pro-escalator',
        summary: '交接给用户',
        text: handoffNotice({ language: cfg.language, reason: '自动干预次数已用尽' }),
      }))
    }, error => logger.warn('turn-stopping 交接失败：', error))
  })

  // ── 自述不确定：从流式回复/思考里捞 ──────────────────────────────────────
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    safe(() => {
      if (!frame || frame.type !== 'chunk') return
      const chunk = frame.chunk
      if (!chunk || (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta')) return
      if (typeof chunk.text !== 'string' || !chunk.text) return
      const state = states.get(agent)
      state.speechTail = (state.speechTail + chunk.text).slice(-600)
      state.chunkCounter += 1
      // 每 8 个增量才跑一次正则，避免逐字扫描。
      if (state.chunkCounter % 8 !== 0) return
      if (!state.selfDoubt && cfg.doubtPattern instanceof RegExp && cfg.doubtPattern.test(state.speechTail)) {
        state.selfDoubt = true
        logger.debug('检测到自述不确定')
      }
    }, () => {})
  })

  // ── 会话销毁：清状态 ──────────────────────────────────────────────────────
  ctx.on('agent/disposed', ({ agent }) => {
    states.delete(agent)
  })

  // ── 内部实现 ──────────────────────────────────────────────────────────────

  /** 把一次工具结果并进状态。 */
  function observe(state, exec, result, config) {
    const tool = String(exec.name ?? '')
    const key = `${tool}\u0000${canonicalize(exec.arguments)}`
    if (key === state.lastKey) state.repeat += 1
    else {
      state.lastKey = key
      state.repeat = 1
      state.lastTool = tool
    }

    const failed = !assessCommandResult(result).ok
    const failureKey = failed ? failureFingerprint(exec, result) : ''
    if (failed && failureKey === state.lastFailureKey) state.repeatedFailure += 1
    else if (failed) state.repeatedFailure = 1
    if (failureKey) state.lastFailureKey = failureKey
    state.consecutiveFailures = failed ? state.consecutiveFailures + 1 : 0
    if (!failed) {
      state.lastProgressStep = state.step
      // 一次成功的调用说明模型恢复了，不确定措辞不再作数。
      state.selfDoubt = false
    }

    if (config.editRe.test(tool)) {
      const path = extractPath(exec.arguments)
      if (path) state.edits.set(path, (state.edits.get(path) ?? 0) + 1)
    }
    // 只在最近 32 个文件上保留计数，防止长会话无限增长。
    if (state.edits.size > 32) {
      const first = state.edits.keys().next().value
      if (first !== undefined) state.edits.delete(first)
    }
  }

  /** 判断是否该干预，返回要附加上去的消息。 */
  async function intervene(agent, state, config, log) {
    if (state.step - state.lastInterventionStep < config.cooldownSteps) return undefined

    const signals = evaluate(state, config)
    const score = signals.reduce((total, signal) => total + signal.weight, 0)
    if (score < config.threshold) return undefined

    state.lastInterventionStep = state.step
    state.interventions += 1
    const lines = signalLines(signals)
    log.info(`第 ${state.step} 步干预 #${state.interventions}（score=${score}）：${signals.map(s => s.kind).join(',')}`)

    // 干预 1：轻提醒。
    if (state.interventions === 1) {
      return createNotice({
        kind: 'v41pro-escalator',
        summary: `卡住提醒：${signals[0].kind}`,
        text: gentleReminder({ language: config.language, lines }),
      })
    }

    // 已达干预上限时先交接，不能在窗口内重新升级覆盖原始回退选择。
    if (state.interventions > config.maxInterventions) {
      state.pendingHandoff = true
      return createNotice({
        kind: 'v41pro-escalator',
        summary: '交接给用户',
        text: handoffNotice({ language: config.language, reason: '同一处阻塞已多次干预仍无进展' }),
      })
    }

    // 干预 2：升级到更强模型；已有升级窗口时保持原回退选择，不再重入。
    if (state.escalatedUntilStep < 0 && config.mode === 'escalate' && config.proModel && state.escalations < config.maxEscalations) {
      const applied = await applyEscalation(agent, state, config, log)
      if (applied) {
        return createNotice({
          kind: 'v41pro-escalator',
          summary: `升级到 ${config.proModel}`,
          text: escalatedNotice({
            language: config.language,
            model: config.proModel,
            steps: config.escalateSteps,
            lines,
          }),
        })
      }
      // 升级不可用（模型不存在 / 没有公开选择 API）：退化成强提醒，不假装升级了。
    }

    // 干预 2（非升级模式 / 已有升级窗口 / 升级未生效）：强提醒 + 有限选项。
    return createNotice({
      kind: 'v41pro-escalator',
      summary: `仍卡住：${signals[0].kind}`,
      text: strongReminder({ language: config.language, lines, tool: state.lastTool }),
    })
  }

  /**
   * 用公开 API 把当前会话的模型换成 proModel。
   *
   * 时序：在 `tools/post-execute` 里调用 → `model/selection` 落进 Session →
   * **下一步**开始按新选择发请求（harness 同时会给模型注入一条 model changed
   * 提示）。探测失败或没有 `agent.model` 时返回 false，调用方退回强提醒。
   */
  async function applyEscalation(agent, state, config, log) {
    if (state.escalatedUntilStep >= 0) return false
    const current = state.selection
    if (!current || typeof current.provider !== 'string' || !current.provider) {
      log.warn('拿不到本步的模型选择，跳过升级')
      return false
    }
    const model = /** @type {any} */ (agent).model
    if (!model || typeof model.select !== 'function') {
      if (!state.escalationUnavailable) {
        state.escalationUnavailable = true
        log.warn('当前 harness 没有 agent.model.select()，模型升级已关闭（提醒仍然生效）')
      }
      return false
    }

    const capability = await resolveProModel(current.provider)
    if (!capability.ok) return false

    /** @type {{ provider: string, model: string, reasoningEffort?: string }} */
    const target = { provider: current.provider, model: config.proModel }
    const effort = pickEffort(capability, current.reasoningEffort)
    if (effort.set && effort.value) target.reasoningEffort = effort.value

    try {
      model.select(target)
    } catch (error) {
      log.warn('写入模型选择失败，保持原模型：', error instanceof Error ? error.message : error)
      return false
    }

    state.escalations += 1
    state.previousSelection = current
    state.escalatedSelection = target
    state.escalatedUntilStep = state.step + config.escalateSteps
    log.info(`第 ${state.step} 步升级到 ${target.model}（provider=${target.provider}，effort=${target.reasoningEffort ?? '默认'}），窗口到第 ${state.escalatedUntilStep} 步`)
    return true
  }

  /**
   * 升级窗口用完后把选择写回原模型。
   *
   * 只在「当前选择仍是本插件写进去的那一个」时回退：如果用户中途自己换了
   * 模型，尊重用户的选择，不再覆盖。
   */
  function restoreIfDue(agent, state, step, log) {
    if (state.escalatedUntilStep < 0) return
    if (step < state.escalatedUntilStep) return

    const model = /** @type {any} */ (agent).model
    const escalated = state.escalatedSelection
    const previous = state.previousSelection
    state.escalatedUntilStep = -1
    state.escalatedSelection = null
    if (!model || typeof model.select !== 'function' || !previous) return

    let current
    try {
      current = typeof model.current === 'function' ? model.current() : undefined
    } catch {
      current = undefined
    }
    if (current && escalated
      && (current.provider !== escalated.provider || current.model !== escalated.model)) {
      log.info('升级窗口结束时模型已被手动更改，保持现状')
      return
    }
    try {
      model.select(previous)
      log.info(`第 ${step} 步升级窗口结束，回到 ${previous.model}`)
    } catch (error) {
      log.warn('回退模型失败：', error instanceof Error ? error.message : error)
    }
  }
}

/** 把新消息并进下游决策，同时保留下游的全部字段与判别式。 */
function withContext(decision, message) {
  const existing = Array.isArray(decision?.additionalContexts) ? decision.additionalContexts : []
  return { ...decision, additionalContexts: [message, ...existing] }
}

/** 等待一个异步函数，异常转成警告而不是抛出。 */
async function safeAsync(fn, onError) {
  try {
    return await fn()
  } catch (error) {
    try {
      onError?.(error)
    } catch {
      /* ignore */
    }
    return undefined
  }
}

/** 归一化配置；非法值回落并记警告。 */
function normalize(raw, logger) {
  const config = raw && typeof raw === 'object' ? raw : {}
  const mode = str(config.mode, DEFAULTS.mode)
  const normalized = {
    mode: ['off', 'advise', 'escalate'].includes(mode) ? mode : DEFAULTS.mode,
    proModel: str(config.proModel, DEFAULTS.proModel),
    proReasoningEffort: str(config.proReasoningEffort, DEFAULTS.proReasoningEffort),
    language: str(config.language, DEFAULTS.language) === 'en' ? 'en' : 'zh',
    threshold: num(config.threshold, DEFAULTS.threshold, { min: 1 }),
    repeatThreshold: num(config.repeatThreshold, DEFAULTS.repeatThreshold, { min: 2 }),
    failureThreshold: num(config.failureThreshold, DEFAULTS.failureThreshold, { min: 2 }),
    editRepeatThreshold: num(config.editRepeatThreshold, DEFAULTS.editRepeatThreshold, { min: 2 }),
    noProgressSteps: num(config.noProgressSteps, DEFAULTS.noProgressSteps, { min: 2 }),
    cooldownSteps: num(config.cooldownSteps, DEFAULTS.cooldownSteps, { min: 0 }),
    maxInterventions: num(config.maxInterventions, DEFAULTS.maxInterventions, { min: 1 }),
    maxEscalations: num(config.maxEscalations, DEFAULTS.maxEscalations, { min: 0 }),
    escalateSteps: num(config.escalateSteps, DEFAULTS.escalateSteps, { min: 1 }),
    editTools: str(config.editTools, DEFAULTS.editTools),
    doubtPattern: str(config.doubtPattern, DEFAULTS.doubtPattern),
  }
  try {
    normalized.editRe = new RegExp(normalized.editTools, 'i')
  } catch {
    normalized.editRe = new RegExp(DEFAULTS.editTools, 'i')
    logger.warn('editTools 不是合法正则，已回落到默认值')
  }
  try {
    normalized.doubtPattern = new RegExp(normalized.doubtPattern, 'i')
  } catch {
    normalized.doubtPattern = new RegExp(DEFAULTS.doubtPattern, 'i')
    logger.warn('doubtPattern 不是合法正则，已回落到默认值')
  }
  return normalized
}
