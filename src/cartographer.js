/**
 * v41pro-cartographer —— 上下文地图（压缩后的重建）。
 *
 * harness 没有「pinned / 永不压缩」的公开 API：压缩一旦发生，早期内容就被摘要
 * 取代，模型再也读不到原文。对 Flash 来说这是最致命的一刀 —— 它本来就不擅长
 * 从摘要里恢复细节，压缩之后会开始**凭印象复述已经不在上下文里的代码**。
 *
 * 所以这里做的是保险：监听 `session/event` 里的 `compaction/*`，一旦压缩发生，
 * 就在下一步注入一张「到哪去找」的地图 —— 不是内容本身（那已被压缩掉），而是
 * 文件索引 + 一句「需要细节就重新读，不要凭印象复述」。
 *
 * 与 ledger 的分工：
 *   ledger       = 事实台账（改过什么、失败过什么），周期性，防重复劳动
 *   cartographer = 位置地图（去哪儿找），事件驱动，防压缩后失忆
 *
 * 默认只在压缩发生后注入（`everySteps: 0`），避免和台账卡片在同一轮里叠罗汉。
 */

import { makeLogger, num, str } from './core/config.js'
import { createSnapshot } from './core/message.js'
import { assessCommandResult, failureSummary } from './core/evidence.js'
import { assessTestSummary, requiresTestEvidence } from './core/evidence.js'
import { blocksToText, extractCommand, extractPath } from './core/util.js'
import { contextMap } from './core/text.js'

export const name = 'v41pro-cartographer'

export const inject = ['tools']

export const DEFAULTS = {
  enabled: true,
  /** 额外周期性注入的间隔；0 表示只在压缩后注入。 */
  everySteps: 0,
  maxEdited: 8,
  maxRead: 10,
  language: 'zh',
  editTools: 'write|edit|patch|apply|create_file|notebook',
  readTools: 'read|cat|view|open|glob|grep|search|list|find',
  commandTools: 'bash|pwsh|shell|exec|command|terminal',
  verifyPatterns: ['\\bnode\\s+[^\\n;&|]*--test\\b', '\\b(?:npm|pnpm|yarn)\\s+(?:run\\s+)?test\\b', '\\bpytest\\b', '\\bmake test\\b', '\\btsc\\b', '\\btypecheck\\b', '\\bcargo check\\b'],
}

/** 会话级状态上限，防止长进程里无限增长。 */
const MAX_SESSIONS = 128

function createState() {
  return {
    tick: 0,
    lastMapTick: -1_000_000,
    compactions: 0,
    pending: false,
    goal: '',
    /** @type {Map<string, number>} */
    edited: new Map(),
    /** @type {Map<string, number>} */
    read: new Map(),
    verification: null,
    verificationFailure: null,
  }
}

/**
 * @param {any} ctx
 * @param {Record<string, unknown>} [rawConfig]
 */
export function apply(ctx, rawConfig = {}) {
  const logger = makeLogger(ctx, name)
  const cfg = normalize(rawConfig, logger)
  if (!cfg.enabled) {
    logger.info('enabled=false，上下文地图已关闭')
    return
  }

  /** @type {Map<string, ReturnType<typeof createState>>} */
  const sessions = new Map()

  /** 取/建会话状态；超出上限时淘汰最早创建的。 */
  function stateOf(sessionId) {
    let state = sessions.get(sessionId)
    if (state === undefined) {
      state = createState()
      sessions.set(sessionId, state)
      if (sessions.size > MAX_SESSIONS) {
        const oldest = sessions.keys().next().value
        if (oldest !== undefined && oldest !== sessionId) sessions.delete(oldest)
      }
    }
    return state
  }

  function keyOf(session) {
    const id = session?.id
    return typeof id === 'string' ? id : String(id ?? '')
  }

  // ── 压缩事件：这是本插件存在的理由 ──────────────────────────────────────
  ctx.on('session/event', (session, event) => {
    try {
      const type = event?.type
      if (typeof type !== 'string' || !type.startsWith('compaction/')) return
      if (type !== 'compaction/start' && type !== 'compaction/end') return
      const state = stateOf(keyOf(session))
      if (type === 'compaction/end') {
        state.compactions += 1
        state.pending = true
        logger.info(`检测到第 ${state.compactions} 次压缩，将在下一步重建上下文地图`)
      }
    } catch (error) {
      logger.warn('压缩事件观测失败：', error instanceof Error ? error.message : error)
    }
  })

  // ── 记录读/写过的文件 ───────────────────────────────────────────────────
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    try {
      const agent = exec?.agent
      if (agent && result?.isError !== true) {
        const state = stateOf(keyOf(agent.session))
        const tool = String(exec.name ?? '')
        const file = extractPath(exec.arguments)
        if (file) {
          if (cfg.editRe.test(tool)) bump(state.edited, file, cfg.maxEdited)
          else if (cfg.readRe.test(tool)) bump(state.read, file, cfg.maxRead)
        }
        if (cfg.commandRe.test(tool)) {
          const command = extractCommand(exec.arguments)
          if (command && cfg.verifyRes.some(pattern => pattern.test(command))) {
            state.verification = {
              command,
              ok: assessCommandResult(result, { requireSummary: requiresTestEvidence(command) }).ok,
              detail: failureSummary(result, 120),
            }
            if (state.verification.ok && state.verificationFailure?.command === command) {
              state.verificationFailure = null
            } else if (!state.verification.ok) {
              state.verificationFailure = { ...state.verification }
            }
          }
        }
      }
    } catch (error) {
      logger.warn('文件索引记录失败：', error instanceof Error ? error.message : error)
    }
    return downstream
  })

  // ── 注入地图 ────────────────────────────────────────────────────────────
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    let card
    try {
      if (decision?.kind === 'enter') {
        const state = stateOf(keyOf(payload.agent?.session))
        state.tick += 1
        captureGoal(state, payload.messages)

        const periodic = cfg.everySteps > 0 && state.tick - state.lastMapTick >= cfg.everySteps
        const hasContent = state.edited.size > 0 || state.read.size > 0 || state.verification !== null || state.verificationFailure !== null
        if ((state.pending || periodic) && hasContent) {
          state.pending = false
          state.lastMapTick = state.tick
          card = buildMap(state, payload.step, cfg)
        } else if (state.pending && !hasContent) {
          // 没有可索引的内容，别注入一张空地图。
          state.pending = false
        }
      }
    } catch (error) {
      logger.warn('上下文地图注入失败：', error instanceof Error ? error.message : error)
    }
    if (!card) return decision
    return { ...decision, messages: [card, ...decision.messages] }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const id = keyOf(agent?.session)
    if (id) sessions.delete(id)
  })

  // ── 内部 ────────────────────────────────────────────────────────────────

  function captureGoal(state, messages) {
    if (state.goal || !Array.isArray(messages)) return
    for (const message of messages) {
      if (message?.source?.kind !== 'user') continue
      const text = blocksToText(message.content).replace(/\s+/g, ' ').trim()
      if (text) {
        state.goal = text.slice(0, 300)
        return
      }
    }
  }

  function buildMap(state, step, config) {
    const edited = recent(state.edited, config.maxEdited)
    const read = recent(state.read, config.maxRead)
    const text = contextMap({
      language: config.language,
      step,
      compactions: state.compactions,
      goal: state.goal,
      edited,
      read,
      verification: state.verification,
      verificationFailure: state.verificationFailure,
    })
    return createSnapshot({
      kind: 'v41pro-cartographer',
      text,
      sections: [
        ...(state.goal ? [{ name: 'goal', text: state.goal }] : []),
        ...(edited.length ? [{ name: 'edited', text: edited.join('\n') }] : []),
        ...(read.length ? [{ name: 'read', text: read.join('\n') }] : []),
        ...(state.verification ? [{ name: 'verification', text: `${state.verification.ok ? '通过' : '未通过'} ${state.verification.command}` }] : []),
        ...(state.verificationFailure ? [{ name: 'verification-failure', text: state.verificationFailure.command }] : []),
      ],
      extra: { compactions: state.compactions },
    })
  }
}

/** 计数并维持上限；超出时删掉最久没碰过的那个。 */
function bump(map, file, limit) {
  map.delete(file)
  map.set(file, (map.get(file) ?? 0) + 1)
  while (map.size > limit) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

/** 最近的 N 个键（Map 的插入顺序即最近使用顺序）。 */
function recent(map, limit) {
  return [...map.keys()].slice(-limit).reverse()
}

function normalize(raw, logger) {
  const config = raw && typeof raw === 'object' ? raw : {}
  const normalized = {
    enabled: config.enabled === false ? false : true,
    everySteps: num(config.everySteps, DEFAULTS.everySteps, { min: 0 }),
    maxEdited: num(config.maxEdited, DEFAULTS.maxEdited, { min: 1 }),
    maxRead: num(config.maxRead, DEFAULTS.maxRead, { min: 1 }),
    language: str(config.language, DEFAULTS.language) === 'en' ? 'en' : 'zh',
    editTools: str(config.editTools, DEFAULTS.editTools),
    readTools: str(config.readTools, DEFAULTS.readTools),
    commandTools: str(config.commandTools, DEFAULTS.commandTools),
  }
  normalized.editRe = compile(normalized.editTools, DEFAULTS.editTools, 'editTools', logger)
  normalized.readRe = compile(normalized.readTools, DEFAULTS.readTools, 'readTools', logger)
  normalized.commandRe = compile(normalized.commandTools, DEFAULTS.commandTools, 'commandTools', logger)
  normalized.verifyRes = DEFAULTS.verifyPatterns.map(pattern => compile(pattern, pattern, 'verifyPatterns', logger))
  return normalized
}

function compile(pattern, fallback, label, logger) {
  try {
    return new RegExp(pattern, 'i')
  } catch {
    logger.warn(`${label} 不是合法正则，已回落到默认值`)
    return new RegExp(fallback, 'i')
  }
}
