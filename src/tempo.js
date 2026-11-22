/**
 * v41pro-tempo —— 预算节拍器。
 *
 * Flash 的另一类事故不是答错，是**温柔地烧钱**：在一个死循环里一轮跑两百步，
 * 或者用同一个工具失败十次还不换。Pro 会自己觉得「该收尾了」，Flash 不会。
 *
 * 三份预算，各自独立触发、各自只提醒一次：
 *   - 步数：本轮跑了多少 step
 *   - 时间：本轮挂了多久（wall clock）
 *   - 同一工具失败次数：换工具/换输入，或者报告阻塞
 *
 * 默认 `mode: advise` 只注入提醒；`mode: steer` 会在 `agent.turn-stopping`
 * 时把回合续命一次，逼它先收尾。续命只发生一次——插件不该变成无法结束的循环。
 */

import { bool, makeLogger, num, str } from './core/config.js'
import { createAgentStore } from './core/state.js'
import { createNotice } from './core/message.js'
import { budgetNotice, timeBudgetNotice, toolFailureNotice } from './core/text.js'

export const name = 'v41pro-tempo'

export const inject = ['tools']

export const DEFAULTS = {
  enabled: true,
  /** 单轮步数上限。0 表示不限制。 */
  maxStepsPerTurn: 60,
  /** 单轮挂钟时间上限（毫秒）。0 表示不限制。 */
  maxWallClockMs: 30 * 60 * 1000,
  /** 同一个工具在一轮里失败多少次算「该换路」。0 表示不限制。 */
  maxToolFailuresPerTool: 5,
  /** 一轮最多发几条预算提醒，防止提醒本身变成噪音。 */
  maxNoticesPerTurn: 2,
  /** 'advise' 只提醒；'steer' 会在收尾时续命一次。 */
  mode: 'advise',
  language: 'zh',
}

function createState() {
  return {
    turn: 0,
    step: 0,
    turnStartStep: 0,
    turnStartAt: 0,
    notices: 0,
    /** @type {Set<string>} */
    warned: new Set(),
    /** @type {Map<string, number>} */
    toolFailures: new Map(),
    /** 是否已经因为预算把回合续命过。 */
    steered: false,
    /** 触发续命的具体原因，供 turn-stopping 使用。 */
    pendingReason: '',
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
    logger.info('enabled=false，预算节拍器已关闭')
    return
  }

  const states = createAgentStore(createState)

  // ── 步边界：维护本轮起点 ────────────────────────────────────────────────
  ctx.on('agent/pre-step', async (payload, next) => {
    try {
      const state = states.get(payload.agent)
      if (payload.turn !== state.turn) {
        state.turn = payload.turn
        state.turnStartStep = payload.step
        state.turnStartAt = Date.now()
        state.notices = 0
        state.warned.clear()
        state.toolFailures.clear()
        state.steered = false
        state.pendingReason = ''
      }
      state.step = payload.step
    } catch (error) {
      logger.warn('pre-step 观测失败：', error instanceof Error ? error.message : error)
    }
    return next()
  })

  // ── 每次工具结果检查预算 ────────────────────────────────────────────────
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    const notice = safeObserve(() => {
      if (!exec?.agent) return undefined
      return check(states.get(exec.agent), exec, result, cfg)
    }, logger)
    if (!notice) return downstream
    return withContext(downstream, notice)
  })

  // ── 收尾：steer 模式下的强制收尾 ────────────────────────────────────────
  ctx.on('agent/turn-stopping', ({ agent }) => {
    if (cfg.mode !== 'steer') return
    try {
      const state = states.get(agent)
      if (state.steered || !state.pendingReason) return
      state.steered = true
      agent.steer(createNotice({
        kind: 'v41pro-tempo',
        summary: '预算用尽，强制收尾',
        text: `${state.pendingReason}\n\n现在只做一件事：把当前最小单元收尾，然后总结。不要再开新的子任务。`,
      }))
    } catch (error) {
      logger.warn('收尾 steer 失败：', error instanceof Error ? error.message : error)
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    states.delete(agent)
  })

  // ── 内部 ────────────────────────────────────────────────────────────────

  function check(state, exec, result, config) {
    const tool = String(exec.name ?? '')
    const failed = result?.isError === true
    if (failed) state.toolFailures.set(tool, (state.toolFailures.get(tool) ?? 0) + 1)

    if (state.notices >= config.maxNoticesPerTurn) return undefined

    const steps = state.step - state.turnStartStep
    if (config.maxStepsPerTurn > 0 && steps >= config.maxStepsPerTurn && !state.warned.has('steps')) {
      state.warned.add('steps')
      state.notices += 1
      state.pendingReason = `本轮已跑 ${steps} 步（预算 ${config.maxStepsPerTurn}）。`
      return createNotice({
        kind: 'v41pro-tempo',
        summary: `步数预算 ${config.maxStepsPerTurn}`,
        text: budgetNotice({ language: config.language, steps, limit: config.maxStepsPerTurn }),
      })
    }

    if (config.maxWallClockMs > 0 && state.turnStartAt > 0 && !state.warned.has('time')) {
      const elapsed = Date.now() - state.turnStartAt
      if (elapsed >= config.maxWallClockMs) {
        state.warned.add('time')
        state.notices += 1
        const minutes = Math.round(elapsed / 60000)
        state.pendingReason = `本轮已跑 ${minutes} 分钟（预算 ${Math.round(config.maxWallClockMs / 60000)}）。`
        return createNotice({
          kind: 'v41pro-tempo',
          summary: `时间预算 ${Math.round(config.maxWallClockMs / 60000)} 分钟`,
          text: timeBudgetNotice({
            language: config.language,
            minutes,
            limit: Math.round(config.maxWallClockMs / 60000),
          }),
        })
      }
    }

    const failures = state.toolFailures.get(tool) ?? 0
    if (config.maxToolFailuresPerTool > 0 && failures >= config.maxToolFailuresPerTool && !state.warned.has(`tool:${tool}`)) {
      state.warned.add(`tool:${tool}`)
      state.notices += 1
      state.pendingReason = `\`${tool}\` 本轮已失败 ${failures} 次。`
      return createNotice({
        kind: 'v41pro-tempo',
        summary: `${tool} 失败 ${failures} 次`,
        text: toolFailureNotice({ language: config.language, tool, failures }),
      })
    }

    return undefined
  }
}

function withContext(decision, message) {
  const existing = Array.isArray(decision?.additionalContexts) ? decision.additionalContexts : []
  return { ...decision, additionalContexts: [message, ...existing] }
}

function safeObserve(fn, logger) {
  try {
    return fn()
  } catch (error) {
    logger.warn('预算检查失败：', error instanceof Error ? error.message : error)
    return undefined
  }
}

function normalize(raw, logger) {
  const config = raw && typeof raw === 'object' ? raw : {}
  const mode = str(config.mode, DEFAULTS.mode)
  return {
    enabled: bool(config.enabled, DEFAULTS.enabled),
    maxStepsPerTurn: num(config.maxStepsPerTurn, DEFAULTS.maxStepsPerTurn, { min: 0 }),
    maxWallClockMs: num(config.maxWallClockMs, DEFAULTS.maxWallClockMs, { min: 0 }),
    maxToolFailuresPerTool: num(config.maxToolFailuresPerTool, DEFAULTS.maxToolFailuresPerTool, { min: 0 }),
    maxNoticesPerTurn: num(config.maxNoticesPerTurn, DEFAULTS.maxNoticesPerTurn, { min: 0 }),
    mode: mode === 'steer' ? 'steer' : 'advise',
    language: str(config.language, DEFAULTS.language) === 'en' ? 'en' : 'zh',
  }
}
