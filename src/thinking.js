/** 发散—聚焦模式：状态来自会话事件，强度通过公开模型选择 API 生效。 */
import z from 'zod'
import { readFileSync } from 'node:fs'
import { createNotice } from './core/message.js'
import { assessCommandResult } from './core/evidence.js'

export const name = 'v41pro-thinking'
export const inject = ['llm', 'skills', 'commands', 'agents', 'sessionProjections', 'tools']
export const DEFAULTS = { enabled: true, mode: 'auto' }
export const MODES = ['auto', 'divergent', 'focused', 'thorough', 'off']
const PHASES = ['divergent', 'focused', 'thorough']
const RANK = { off: 0, none: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6 }
const LABEL = { auto: '自动', divergent: '发散', focused: '聚焦', thorough: '透彻', off: '关闭' }
const same = (a, b) => a?.provider === b?.provider && a?.model === b?.model && a?.reasoningEffort === b?.reasoningEffort
const initialPhase = mode => PHASES.includes(mode) ? mode : 'divergent'
const floor = phase => phase === 'thorough' ? 'max' : phase === 'focused' ? 'high' : 'low'
const effortLabel = phase => phase === 'thorough' ? '仅限 max' : `最低 ${floor(phase)}`

export function minimumEffort(info, current, phase) {
  const minimum = floor(phase)
  const allowed = info?.reasoning?.efforts?.map(item => item.id) ?? []
  if (phase === 'thorough') {
    if (!allowed.includes('max')) throw new Error('透彻思考仅限 max：当前模型未声明 max 档位，不能用 high、xhigh 或其他最高档替代。请选择支持 max 的模型，或切换思考模式。')
    return 'max'
  }
  const selected = current ?? info?.reasoning?.defaultEffort
  if (allowed.includes(selected) && RANK[selected] >= RANK[minimum]) return selected
  const candidate = allowed.filter(id => RANK[id] >= RANK[minimum]).sort((a, b) => RANK[a] - RANK[b])[0]
  if (!candidate) throw new Error(`当前模型没有已声明的 ${minimum} 或更高思考档位，无法启用${LABEL[phase]}思考。请选择支持该强度的模型，或用 /thinking off 关闭思考模块。`)
  return candidate
}

export function initialState(mode = 'auto') {
  return { mode, phase: initialPhase(mode), reopens: 0, failures: 0,
    lastUser: '', responsePhase: 'none', contextKey: '', baseline: null, applied: null, pending: {} }
}

function freshTask(state, message) {
  if (message?.source?.kind !== 'user' || message.id === state.lastUser) return state
  const text = message.content?.filter(b => b.type === 'text').map(b => b.text).join('\n').trim() ?? ''
  if (/^(继续|继续工作|continue|resume)[。.!！\s]*$/i.test(text)) return { ...state, lastUser: message.id }
  return { ...state, lastUser: message.id, phase: initialPhase(state.mode),
    reopens: 0, failures: 0, responsePhase: 'none', contextKey: '' }
}

export function foldThinking(state, event) {
  const data = event.data
  if (event.type === 'command/run' && data.name === 'thinking') {
    const mode = data.args?.trim().toLowerCase()
    if (!MODES.includes(mode)) return state
    return { ...state, pending: { ...Object.fromEntries(Object.entries(state.pending).slice(-15)), [data.commandId]: mode } }
  }
  if (event.type === 'command/done' && state.pending[data.commandId]) {
    const mode = state.pending[data.commandId]
    const pending = { ...state.pending }
    delete pending[data.commandId]
    if (data.kind !== 'success') return { ...state, pending }
    return { ...state, mode, phase: initialPhase(mode), reopens: 0,
      failures: 0, responsePhase: 'none', contextKey: '', pending,
      ...(mode === 'off' ? { baseline: null, applied: null } : {}) }
  }
  if (event.type === 'user/message') {
    const next = freshTask(state, data)
    if (data.source?.kind !== name || data.source?.version !== 1) return next
    const control = data.source.control
    if (control?.release === true) return { ...next, contextKey: '', baseline: null, applied: null }
    if (!control || control.mode !== state.mode || !MODES.includes(control.mode) || !PHASES.includes(control.phase)) return next
    return { ...next, contextKey: control.key, baseline: control.baseline, applied: control.applied }
  }
  if (state.mode === 'off') return state
  if (event.type === 'assistant/message' && !data.interrupted) {
    return { ...state, responsePhase: state.phase, phase: state.mode === 'auto' ? 'focused' : state.phase }
  }
  if (event.type === 'tool/result' && state.mode === 'auto') {
    const failed = !assessCommandResult({ content: data.message?.content ?? [], isError: data.message?.isError }).ok
    const failures = failed ? state.failures + 1 : 0
    if (failures >= 2 && state.phase === 'focused' && state.reopens < 2) {
      return { ...state, phase: 'divergent', reopens: state.reopens + 1, failures: 0 }
    }
    return failures === state.failures ? state : { ...state, failures }
  }
  return state
}

export function phaseText(state) {
  if (state.mode === 'off') return '思考模块已关闭。此前本模块的阶段指令不再适用，按用户要求正常工作。'
  const head = `思考模式：${LABEL[state.mode]}；当前阶段：${LABEL[state.phase]}；思考强度：${effortLabel(state.phase)}。此状态替代此前本模块的阶段指令。`
  const common = '遵循 diverge-focus-reasoning 技能；实际任务同时加载 best-effort-agent 执行准则：明确成果与验收步骤、真正执行、核实信息、查明失败根因、交付前自检并如实报告，不为节省用量省略必要步骤；已有授权内继续工作，新增高风险操作按宿主规则确认。只向用户提供简洁的目标、方案、关键依据、验证结果和结论，不要求公开内部思维过程。简单事实问题直接回答，不为凑数拆分。'
  if (state.phase === 'thorough') return `${head}\n${common}\n自动开展刨根问底的深入工作，无需用户逐步催促：明确真实目标、验收标准与约束，区分已知事实、假设和不确定项；从现象沿因果链追问到有证据支撑的根因，检查隐藏前提、依赖与边界条件。提出竞争性解释，用反例、反证或最小实验排除它们；根据任务使用可用工具检索、复现、计算或测试，并交叉验证关键结论。证据冲突时修正假设；不要把相关性当因果，不要为显得深刻而虚构原因。实际任务完成实施与回归验证后再交付；最终给出结论、关键证据、验证结果、剩余不确定性与下一步，不输出冗长内部思维。关键疑点得到证据闭合或已明确能力/信息阻碍时收敛，不作无目的重复，遵守用户范围与预算。遇到需要多路径搜索、反例检验或交叉验证的复杂问题，优先调用 reasoning_max（分层算力、并行候选、MCTS、PRM 评审），不要只靠一次性直觉；简单问题不要调用，避免浪费算力。`
  if (state.phase === 'divergent') return `${head}\n${common}\n先理解目标与约束，从正向、逆向、特例等角度拆解问题；复杂任务先列候选，再合并为有输入与依赖关系的 Q1…Qn。${state.reopens ? '当前方案连续失败，重新检查假设并选择一个替代方向；整体最多回溯两次。' : ''}${state.mode === 'auto' ? '简单事实或闲聊可直接回答结束；复杂任务先完成拆解与必要的信息收集。若下一步已有工具调用，随后自动进入聚焦；纯文本推理任务在拆解完成后调用 pro_focus，进入最低 high 的下一次请求继续求解。不要只交计划就停止。' : '本模式以多角度探索和方案比较为主；用户要求落地时仍须完成执行、汇聚与验证。'}`
  return `${head}\n${common}\n按依赖顺序一次攻克一个模块，只引用前面模块的结论。每个模块给出结论、关键依据、验证与置信度；失败最多重做一次，仍无解标记待定。汇聚结论、检查冲突、逐项对照约束并作最终验证；最终先给结论，再给必要依据与不确定项。`
}

export async function apply(ctx, config = {}) {
  if (config.enabled === false) return
  const defaultMode = MODES.includes(config.mode) ? config.mode : DEFAULTS.mode
  const selection = z.object({ provider: z.string(), model: z.string(), reasoningEffort: z.string().optional() }).nullable()
  const stateSchema = z.object({ mode: z.enum(MODES), phase: z.enum(PHASES), reopens: z.number(),
    failures: z.number(), lastUser: z.string(), responsePhase: z.enum(['none', ...PHASES]), contextKey: z.string(),
    baseline: selection, applied: selection, pending: z.record(z.string(), z.string()) })
  const viewSchema = z.object({ mode: z.enum(MODES), phase: z.enum(PHASES), reopens: z.number() })
  const projection = await ctx.sessionProjections.register({ key: 'v41proThinking', stateVersion: 1, stateSchema,
    init: () => initialState(defaultMode), apply: foldThinking,
    wire: { viewSchema, summary: false, view: s => ({ mode: s.mode, phase: s.phase, reopens: s.reopens }) } })
  const source = readFileSync(new URL('../skills/diverge-focus-reasoning/SKILL.md', import.meta.url), 'utf8')
  ctx.effect(() => ctx.skills.register({ name: 'diverge-focus-reasoning', source: 'runtime', provider: 'runtime',
    description: '发散—聚焦推理：理解目标，多角度拆解，按依赖聚焦攻坚，再汇聚与交叉验证。复杂任务或用户明确要求时使用；简单事实与闲聊直接回答。',
    invocation: { modelInvocable: true, userInvocable: true }, content: source.replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, '')
      + '\n\n## DSH 模式适配\n本模块的最新阶段提示决定本次任务侧重点。输出可核验的关键依据与结论，不要求展示内部思维过程；保留技能的验证、有限重试与不确定性规则。' }))
  const bestEffort = readFileSync(new URL('../skills/best-effort-agent/SKILL.md', import.meta.url), 'utf8')
  ctx.effect(() => ctx.skills.register({ name: 'best-effort-agent', source: 'runtime', provider: 'runtime',
    description: '实际任务的全力执行准则：理解目标、拆解可验证步骤、逐项落实、核实信息、查根因、交付前自检并如实报告，不为节省用量省略必要工作。',
    invocation: { modelInvocable: true, userInvocable: true }, content: bestEffort.replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, '')
      + '\n\n## DSH 适配\n通过 DSH 技能入口或 skill 工具加载本技能。既有用户授权持续有效；必要且已授权的可逆工作直接完成，新的高风险操作按宿主权限与确认规则处理。遵守用户明确的预算约束。' }))
  const pendingRestart = new WeakMap()
  const adjustments = new WeakMap()
  const owned = new Map()
  let disposed = false

  function baselineOf(agent, state, current) {
    const saved = owned.get(agent) ?? state
    return saved.applied && same(saved.applied, current) && saved.baseline ? saved.baseline : current
  }
  function restore(agent, state) {
    const saved = owned.get(agent) ?? state
    if (saved.applied && saved.baseline && same(saved.applied, agent.model.current())) agent.model.select(saved.baseline)
    owned.delete(agent)
  }

  ctx.effect(() => ctx.commands.register({ name: 'thinking', description: '思考模式：自动、发散（≥low）、聚焦（≥high）、透彻（仅 max）或关闭。',
    input: { hint: 'auto | divergent | focused | thorough | off | status' },
    async handler({ agent, rawInput, signal }) {
      const mode = rawInput.trim().toLowerCase() || 'status'
      const state = projection.stateOf(agent.session)
      if (mode === 'status') return { kind: 'success', text: `思考模式：${LABEL[state.mode]}；当前阶段：${LABEL[state.phase]}${state.mode === 'off' ? '' : `；${effortLabel(state.phase)}`}。` }
      if (!MODES.includes(mode)) return { kind: 'error', text: '用法：/thinking auto | divergent | focused | thorough | off | status' }
      if (mode !== 'off') {
        const current = agent.model.current()
        if (!current) return { kind: 'error', text: '请先选择模型。' }
        try {
          const info = await ctx.llm.resolveModelInfo(current.provider, current.model, signal)
          if (disposed) return { kind: 'error', text: '思考模块已卸载，模式未更改。' }
          signal.throwIfAborted()
          minimumEffort(info, current.reasoningEffort, mode === 'auto' ? 'focused' : initialPhase(mode))
        }
        catch (error) { return { kind: 'error', text: error.message } }
      } else restore(agent, state)
      return { kind: 'success', text: `已切换为${LABEL[mode]}思考${mode === 'off' ? '' : '，从下一个尚未准备的模型请求生效'}。` }
    } }))

  function trackRestored(agent) {
    const state = projection.stateOf(agent.session)
    if (state.mode !== 'off' && state.applied && state.baseline && same(state.applied, agent.model.current())) {
      owned.set(agent, { baseline: state.baseline, applied: state.applied })
    }
  }
  ctx.on('agent/created', ({ agent }) => trackRestored(agent))
  for (const agent of ctx.agents.list()) trackRestored(agent)

  ctx.effect(() => ctx.tools.register({ name: 'pro_focus',
    description: '自动思考模式下，复杂任务完成发散拆解后调用，进入至少 high 的聚焦请求继续求解与验证。适用于没有其他工具可调用的纯文本任务；简单事实与闲聊直接回答，不调用。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(_args, { agent, signal }) {
      signal.throwIfAborted()
      if (disposed || !agent || projection.stateOf(agent.session).mode !== 'auto') throw new Error('pro_focus 仅用于已启用的自动思考模式。')
      return '发散拆解已结束。下一次请求将使用至少 high 的聚焦档位；继续按依赖求解、验证并交付答案，不要重复调用本工具。'
    },
  }, { when: ({ agent }) => !disposed && projection.stateOf(agent.session).mode === 'auto' }))

  // Reasoning Max 3.0（Python 架构移植）：挂在已热重载的 thinking 模块上，不新增 patch 行，
  // 因此无需重启 DSH 即可生效。动态 import 带 rev 查询串，编辑引擎后重载 thinking 就能拿到新实现。
  let rmax = null
  try { rmax = await import(`./reasoning-max.js?rev=${Date.now()}`) }
  catch (error) { ctx.logger?.warn?.(`[v41pro-thinking] Reasoning Max 加载失败：${error?.message ?? error}`) }
  if (rmax && config.reasoningMax?.enabled !== false) {
    const settings = config.reasoningMax && typeof config.reasoningMax === 'object' ? config.reasoningMax : {}
    const engineFor = agent => {
      const selection = agent?.model?.current?.()
      if (!selection?.provider || !selection?.model) throw new Error('请先选择模型，再使用 reasoning_max。')
      const cfg = rmax.normalizeConfig(settings)
      return { engine: rmax.createEngine({ chat: rmax.createLlmChat(ctx.llm, selection, cfg), config: cfg, selection }), cfg }
    }
    const clipAnswer = text => {
      const value = String(text ?? '')
      return value.length <= 8000 ? value : `${value.slice(0, 8000)}\n…[已截断]`
    }
    ctx.effect(() => ctx.tools.register({ name: 'reasoning_max',
      description: 'Reasoning Max 3.0：按难度选算力（low/medium/high），并行候选 + MCTS 步骤树 + PRM 逐步评审 + 独立评审 + 综合；输出结论、证据、不确定性与运行轨迹。适合复杂、开放、需要交叉验证的问题；简单事实与闲聊不要调用（会多次调用模型，很贵）。',
      parameters: { type: 'object', properties: {
        question: { type: 'string', description: '要解决的问题；包含目标、约束、验收标准。' },
        tier: { type: 'string', enum: ['low', 'medium', 'high'], description: '强制算力档；省略时按问题自动选择。' },
        mode: { type: 'string', enum: ['auto', 'ensemble', 'mcts'], description: 'auto=候选+MCTS；ensemble=只用并行候选；mcts=只用树搜索。' },
        iterations: { type: 'integer', minimum: 0, maximum: 40, description: 'MCTS 迭代上限；0 表示用档位默认值。' },
        tokenBudget: { type: 'integer', minimum: 0, description: 'token 粗估预算；0 表示用档位默认值。' },
        timeBudget: { type: 'number', minimum: 0, description: '时间预算（秒）；0 表示用档位默认值。' },
      }, required: ['question'], additionalProperties: false },
      output: { schema: { type: 'object', properties: {
        answer: { type: 'string' }, trace: { type: 'string' }, tier: { type: 'string' }, stop_reason: { type: 'string' },
        escalated: { type: 'boolean' }, verdict: { type: 'string' }, confidence: { type: 'number' },
        tokens: { type: 'integer' }, calls: { type: 'integer' }, elapsed_seconds: { type: 'number' }, reward: { type: 'number' },
      }, required: ['answer', 'trace'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: `${value.answer}\n\n---\n${value.trace}` }] },
      async execute(args, exec) {
        exec.signal?.throwIfAborted?.()
        if (disposed) throw new Error('思考模块已卸载。')
        const question = String(args?.question ?? '').trim()
        if (!question) throw new Error('reasoning_max 需要 question。')
        const { engine } = engineFor(exec.agent)
        const result = await engine.solveFull(question, { tier: args.tier, mode: args.mode,
          iterations: args.iterations, tokenBudget: args.tokenBudget, timeBudget: args.timeBudget, signal: exec.signal })
        return { answer: result.answer, trace: engine.traceOf(result), tier: result.tier, stop_reason: result.stopReason,
          escalated: result.escalated, verdict: result.verdict, confidence: result.confidence,
          tokens: result.usage.totalTokens, calls: result.usage.calls,
          elapsed_seconds: Math.round(result.elapsed * 10) / 10, reward: result.reward.value }
      },
    }, { when: () => !disposed }))
    ctx.effect(() => ctx.commands.register({ name: 'reasoning-max',
      description: 'Reasoning Max 3.0：分层算力 + 并行候选 + MCTS + PRM 评审。用法 /reasoning-max <问题> | stats | export。',
      input: { hint: '<问题> | stats | export' },
      async handler({ agent, rawInput, signal }) {
        const text = String(rawInput ?? '').trim()
        if (!text) return { kind: 'error', text: '用法：/reasoning-max <问题> | stats | export' }
        try {
          if (text === 'stats') {
            const cfg = rmax.normalizeConfig(settings)
            const stats = await rmax.statsOf(rmax.stateDir(cfg))
            const head = `Reasoning Max 3.0：episodes=${stats.episodes}，meanReward=${stats.meanReward.toFixed(3)}，calls=${stats.calls}`
            return { kind: 'success', text: [head, ...(stats.tables.length ? stats.tables : ['（还没有路由统计；首次调用后会生成。）'])].join('\n') }
          }
          if (text === 'export') {
            const cfg = rmax.normalizeConfig(settings)
            const dir = rmax.stateDir(cfg)
            const report = await rmax.exportTraining(dir)
            return { kind: 'success', text: `已导出到 ${dir}：episodes=${report.episodes}，prm_steps=${report.prmSteps}，preference_pairs=${report.preferencePairs}，sft_best=${report.sftBest}。` }
          }
          const { engine } = engineFor(agent)
          const result = await engine.solveFull(text, { signal })
          return { kind: 'success', text: `${clipAnswer(result.answer)}\n\n---\n${engine.traceOf(result)}` }
        } catch (error) {
          return { kind: 'error', text: `Reasoning Max 失败：${error?.message ?? error}` }
        }
      } }))
  }

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (disposed || decision.kind !== 'enter' || payload.signal.aborted) return decision
    const agent = payload.agent
    let state = projection.stateOf(agent.session)
    for (const message of decision.messages) state = freshTask(state, message)
    const captured = payload.modelSelection
    if (state.mode === 'off') {
      return state.contextKey === 'off' ? decision : { ...decision, messages: [...decision.messages,
        createNotice({ kind: name, summary: '思考模块已关闭', text: phaseText(state), extra: { version: 1, control: { mode: 'off', phase: state.phase, key: 'off', baseline: null, applied: null } } })] }
    }
    let desired
    let baseline
    try {
      const info = await ctx.llm.resolveModelInfo(captured.provider, captured.model, payload.signal)
      if (disposed) return decision
      payload.signal.throwIfAborted()
      state = projection.stateOf(agent.session)
      for (const message of decision.messages) state = freshTask(state, message)
      if (state.mode === 'off') return { ...decision, messages: [...decision.messages,
        createNotice({ kind: name, summary: '思考模块已关闭', text: phaseText(state), extra: { version: 1, control: { mode: 'off', phase: state.phase, key: 'off', baseline: null, applied: null } } })] }
      // 自动模式也预检聚焦能力，避免先产生低强度计划后才发现无法执行。
      if (state.mode === 'auto') minimumEffort(info, captured.reasoningEffort, 'focused')
      baseline = baselineOf(agent, state, captured)
      desired = { ...captured, reasoningEffort: minimumEffort(info, baseline.reasoningEffort, state.phase) }
    } catch (error) {
      if (disposed) return decision
      if (!payload.signal.aborted) for (const message of payload.messages) agent.inject(message)
      throw error
    }
    const current = agent.model.current()
    if (!same(captured, current) || !same(captured, desired)) {
      const count = (adjustments.get(agent) ?? 0) + 1
      adjustments.set(agent, count)
      if (count > 3) {
        for (const message of payload.messages) agent.inject(message)
        throw new Error('思考强度被其他设置反复改写，已停止自动调整。请确认模型选择后继续。')
      }
      if (same(captured, current)) {
        agent.model.select(desired)
        owned.set(agent, { baseline, applied: desired })
      }
      // 本步选择已经冻结：先保留原始输入、拒绝低于下限的请求，再在 idle 边界重新准备。
      for (const message of payload.messages) agent.inject(message)
      pendingRestart.set(agent, payload.signal)
      return { kind: 'reject' }
    }
    if (!owned.has(agent) && state.applied && state.baseline && same(state.applied, captured)) {
      owned.set(agent, { baseline: state.baseline, applied: state.applied })
    }
    adjustments.delete(agent)
    const saved = owned.get(agent)
    const key = `${state.mode}:${state.phase}:${state.reopens}:${state.lastUser}:${captured.provider}:${captured.model}:${captured.reasoningEffort}`
    if (state.contextKey === key) return decision
    return { ...decision, messages: [...decision.messages, createNotice({ kind: name,
      summary: `${LABEL[state.mode]}思考 · ${LABEL[state.phase]} · ${effortLabel(state.phase)}`, text: phaseText(state),
      extra: { version: 1, control: { mode: state.mode, phase: state.phase, key,
        baseline: saved?.baseline ?? state.baseline, applied: saved?.applied ?? state.applied } } })] }
  })
  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle' || !pendingRestart.has(agent)) return
    const signal = pendingRestart.get(agent)
    pendingRestart.delete(agent)
    if (disposed || signal.aborted) return
    agent.steer(createNotice({ kind: name, summary: '思考强度已就绪', text: '思考强度已调整；继续处理刚才的原始任务，不要求用户重复输入。' }))
  })
  ctx.on('agent/disposed', ({ agent }) => { pendingRestart.delete(agent); adjustments.delete(agent); owned.delete(agent) })
  ctx.effect(() => () => {
    disposed = true
    for (const [agent, saved] of owned) {
      try {
        restore(agent, saved)
        agent.session.append('user/message', createNotice({ kind: name, summary: '思考模块已卸载',
          text: '思考模块已卸载，临时档位控制已撤销，此前阶段指令不再适用。',
          extra: { version: 1, control: { release: true } } }), { surfaceOp: 'append' })
      } catch { /* 宿主关闭时会话可能已撤销。 */ }
    }
  })
}
