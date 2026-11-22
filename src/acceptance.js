/**
 * v41pro-acceptance —— 验收闸门。
 *
 * 验证器证明的是「我跑的命令退出 0」，但用户真正要的东西往往更大：页面能打开、
 * 产物文件真的存在、接口返回预期字段。这个模块让模型**在开始动手时**就把验收
 * 标准写成可执行检查，收尾时如果还有没验证的项，就强制续命一次。
 *
 * 三件事：
 *  1. `acceptance` 工具：define / check / list / complete / clear。
 *     check 真的走 `ctx.shell` 执行 cmd，或检查 file 是否存在且非空；
 *     manual 标准不假装自动验证，保持 pending。
 *  2. `agent/turn-stopping` 门禁：还有未验证项就 `agent.steer()` 续命一次；
 *     每回合最多一次 —— 插件不该变成无法结束的循环。
 *  3. `agent/pre-step`：进入新回合时注入一张待办快照（≤5 项 + 计数），
 *     提醒模型自己许下的标准，且每回合只注入一次。
 *
 * 状态落盘在 `$DSH_HOME/v41pro/acceptance/<sessionId>.acceptance.json`。
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

import { bool, makeLogger, num, str } from './core/config.js'
import { createAgentStore, sessionKey } from './core/state.js'
import { createNotice, createSnapshot } from './core/message.js'
import { sourceNote } from './core/text.js'
import { truncate } from './core/util.js'
import { SessionJson, makeId, v41Dir } from './core/persist.js'

export const name = 'v41pro-acceptance'

/** 验收检查要靠 shell 真跑命令；没有它 cmd 类标准只能记失败。 */
export const inject = ['tools', 'commands', 'shell']

export const DEFAULTS = {
  enabled: true,
  /** 是否启用收尾闸门。false 时只提供工具与命令。 */
  gate: true,
  /** 一回合最多催几次验收检查。 */
  maxNudges: 1,
  language: 'zh',
  /** 一个会话最多保存多少条验收标准。 */
  maxCriteria: 20,
  /** cmd 类标准的默认超时。 */
  timeoutMs: 120_000,
}

const ACTIONS = new Set(['define', 'check', 'list', 'complete', 'clear'])
const CRITERION_TYPES = new Set(['cmd', 'file', 'manual'])
const STATUS_ICONS = { verified: '✓', failed: '✗', pending: '·' }
const STATUS_LABELS = {
  zh: { verified: '通过', failed: '失败', pending: '待验证' },
  en: { verified: 'passed', failed: 'failed', pending: 'pending' },
}
/** 单条证据保留的最大字符数。 */
const MAX_EVIDENCE_CHARS = 200

/** 供测试：不依赖 cordis 运行时也能构造状态。 */
export function __createState(agent) {
  return createState(sessionKey(agent))
}

/**
 * @param {any} ctx
 * @param {Record<string, unknown>} [rawConfig]
 */
export function apply(ctx, rawConfig = {}) {
  const logger = makeLogger(ctx, name)
  const cfg = normalize(rawConfig, logger)
  if (!cfg.enabled) {
    logger.info('enabled=false，验收闸门已关闭')
    return
  }

  const states = createAgentStore(agent => createState(sessionKey(agent)))
  const store = new SessionJson(cfg.dir, 'acceptance')
  /** 串行写盘：保证「工具 await 保存完成」与并发保存的落盘顺序。 */
  /** @type {Promise<void>} */
  let writeChain = Promise.resolve()

  // ── 会话建立：从磁盘恢复状态 ────────────────────────────────────────────
  // 与 ledger 同理：不在 agent/created 里 await，避免拖慢新会话启动；
  // 工具/事件侧统一 `await state.ready`。
  ctx.effect(() => ctx.on('agent/created', ({ agent } = {}) => {
    if (!agent) return
    const state = states.get(agent)
    if (!state.key) return
    state.ready = loadState(state)
      .catch(error => logger.warn('读取验收标准失败，按空状态继续：', messageOf(error)))
      .finally(() => {
        state.loaded = true
      })
  }), 'v41pro-acceptance load')

  // ── 步边界：每回合重置催办计数，并注入一次待办快照 ──────────────────────
  ctx.effect(() => ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    let snapshot
    try {
      if (decision?.kind !== 'enter') return decision
      const state = states.get(payload?.agent)
      await state.ready
      syncTurn(state, payload?.turn)
      if (state.notifiedTurn) return decision
      const pending = unverifiedOf(state.criteria)
      if (pending.length === 0) return decision
      state.notifiedTurn = true
      snapshot = createSnapshot({
        kind: name,
        text: pendingCard({ language: cfg.language, pending, total: state.criteria.length }),
        sections: [{
          name: 'criteria',
          text: pending.slice(0, 5).map(criterion => `- ${criterionBrief(criterion, cfg.language)}`).join('\n'),
        }],
      })
    } catch (error) {
      logger.warn('验收标准注入失败：', messageOf(error))
      return decision
    }
    const existing = Array.isArray(decision.messages) ? decision.messages : []
    return { ...decision, messages: [snapshot, ...existing] }
  }), 'v41pro-acceptance pre-step')

  // ── 收尾门禁：未验证就续命一次 ──────────────────────────────────────────
  ctx.effect(() => ctx.on('agent/turn-stopping', (payload) => {
    if (!cfg.gate) return
    try {
      const agent = payload?.agent
      if (!agent) return
      const state = states.get(agent)
      syncTurn(state, payload?.turn)
      const pending = unverifiedOf(state.criteria)
      if (pending.length === 0) return
      if (state.nudges >= cfg.maxNudges) {
        logger.warn(`本轮已催过 ${state.nudges} 次验收检查，放行收尾`)
        return
      }
      state.nudges += 1
      logger.info(`收尾拦截：${pending.length}/${state.criteria.length} 条验收标准未验证`)
      agent.steer(createNotice({
        kind: name,
        summary: `验收未通过：${pending.length} 项待验证`,
        text: gateNudge({ language: cfg.language, pending, total: state.criteria.length }),
      }))
      queueSave(state)
    } catch (error) {
      logger.warn('验收收尾闸门失败：', messageOf(error))
    }
  }), 'v41pro-acceptance gate')

  // ── 会话销毁：刷盘后清理 ────────────────────────────────────────────────
  ctx.effect(() => ctx.on('agent/disposed', async ({ agent } = {}) => {
    if (!agent) return
    const state = states.peek(agent)
    if (!state) return
    try {
      await queueSave(state)
    } catch {
      // queueSave 内部已记录；销毁路径不能向外抛错。
    }
    states.delete(agent)
  }), 'v41pro-acceptance cleanup')

  // ── 工具：acceptance ────────────────────────────────────────────────────
  if (ctx.tools && typeof ctx.tools.register === 'function') {
    ctx.effect(() => {
      const disposer = ctx.tools.register({
        name: 'acceptance',
        description: buildToolDescription(cfg),
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['define', 'check', 'list', 'complete', 'clear'],
              description: 'define 写入标准；check 真执行；list 查看；complete 收尾判定；clear 清空。',
            },
            criteria: {
              type: 'array',
              description: 'define 用的标准列表；默认追加，replace=true 时替换。',
              items: {
                type: 'object',
                properties: {
                  text: { type: 'string', description: '一句可读的验收描述。必填。' },
                  type: {
                    type: 'string',
                    enum: ['cmd', 'file', 'manual'],
                    description: 'cmd 跑命令（默认），file 检查文件，manual 需人工确认。',
                  },
                  command: { type: 'string', description: 'type=cmd 时必填，交给 ctx.shell 执行。' },
                  path: { type: 'string', description: 'type=file 时必填，检查存在且非空。' },
                  expect_exit_code: { type: 'integer', description: 'type=cmd 期望的退出码，默认 0。' },
                  timeout_ms: { type: 'integer', description: 'type=cmd 的单条超时，默认取插件配置。' },
                },
                required: ['text'],
                additionalProperties: false,
              },
            },
            replace: { type: 'boolean', description: 'define 时替换已有标准而不是追加。' },
            timeout_ms: { type: 'integer', description: 'check 时覆盖所有 cmd 的超时。' },
          },
          required: ['action'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              action: { type: 'string', enum: ['define', 'check', 'list', 'complete', 'clear'] },
              text: { type: 'string' },
              criteria: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    text: { type: 'string' },
                    type: { type: 'string', enum: ['cmd', 'file', 'manual'] },
                    status: { type: 'string', enum: ['pending', 'verified', 'failed'] },
                    evidence: { type: 'string' },
                    checkedAt: { type: 'string' },
                  },
                  required: ['id', 'text', 'type', 'status', 'evidence', 'checkedAt'],
                  additionalProperties: false,
                },
              },
              counts: {
                type: 'object',
                properties: {
                  total: { type: 'integer' },
                  verified: { type: 'integer' },
                  failed: { type: 'integer' },
                  pending: { type: 'integer' },
                },
                required: ['total', 'verified', 'failed', 'pending'],
                additionalProperties: false,
              },
              unverified: { type: 'array', items: { type: 'string' } },
            },
            required: ['ok', 'action', 'text', 'criteria', 'counts', 'unverified'],
            additionalProperties: false,
          },
          render(_args, value) {
            return [{ type: 'text', text: String(value?.text ?? '') }]
          },
        },
        async execute(args, exec) {
          const input = args && typeof args === 'object' ? args : {}
          const action = str(input.action, '').trim()
          if (!ACTIONS.has(action)) {
            throw new Error(`acceptance 需要 action ∈ define | check | list | complete | clear，收到 "${action}"。`)
          }
          const agent = exec?.agent
          if (!agent) throw new Error('acceptance 需要 agent 上下文（缺少 exec.agent）。')
          const state = states.get(agent)
          await state.ready
          if (action === 'define') return defineCriteria(state, input)
          if (action === 'check') return checkCriteria(state, exec, input)
          if (action === 'list') return listCriteria(state)
          if (action === 'complete') return completeCriteria(state)
          return clearCriteria(state)
        },
      })
      return () => {
        try {
          disposer?.()
        } catch {
          /* ignore */
        }
      }
    }, 'v41pro-acceptance tool')
  }

  // ── 命令：/accept ───────────────────────────────────────────────────────
  if (ctx.commands && typeof ctx.commands.register === 'function') {
    ctx.effect(() => {
      const disposer = ctx.commands.register({
        name: 'accept',
        description: '查看或清理验收标准',
        input: { hint: 'status | clear | check' },
        async handler({ agent, rawInput, signal } = {}) {
          try {
            if (!agent) return { kind: 'error', text: 'accept 需要 agent 上下文。' }
            const state = states.get(agent)
            await state.ready
            const sub = (str(rawInput, '').trim().toLowerCase().split(/\s+/)[0]) || 'status'
            if (sub === 'status') {
              return { kind: 'success', text: listText({ language: cfg.language, criteria: state.criteria }) }
            }
            if (sub === 'check') {
              const value = await checkCriteria(state, { agent, signal }, {})
              return { kind: 'success', text: value.text }
            }
            if (sub === 'clear') {
              const value = await clearCriteria(state)
              return { kind: 'success', text: value.text }
            }
            return { kind: 'error', text: `未知子命令 "${sub}"；可用：status | check | clear。` }
          } catch (error) {
            logger.warn('accept 命令失败：', messageOf(error))
            return { kind: 'error', text: `accept 执行失败：${messageOf(error)}` }
          }
        },
      })
      return () => {
        try {
          disposer?.()
        } catch {
          /* ignore */
        }
      }
    }, 'v41pro-acceptance.command')
  }

  // ── 工具实现 ────────────────────────────────────────────────────────────

  async function defineCriteria(state, input) {
    if (!Array.isArray(input.criteria)) {
      throw new Error('acceptance define 需要 criteria 数组；每项至少要有 text。')
    }
    const parsed = input.criteria.map((item, index) => parseCriterion(item, index))
    const replace = bool(input.replace, false)
    const next = replace ? [...parsed] : [...state.criteria, ...parsed]
    if (next.length > cfg.maxCriteria) {
      throw new Error(`验收标准最多 ${cfg.maxCriteria} 条，本次会变成 ${next.length} 条；先 clear 或减少条目。`)
    }
    state.criteria = next
    await queueSave(state)
    const zh = cfg.language !== 'en'
    const counts = countCriteria(state.criteria)
    const lines = [replace
      ? (zh ? `已替换为 ${parsed.length} 条验收标准（共 ${counts.total} 条）。` : `Replaced with ${parsed.length} criteria (${counts.total} total).`)
      : (zh ? `已追加 ${parsed.length} 条验收标准（共 ${counts.total} 条）。` : `Appended ${parsed.length} criteria (${counts.total} total).`)]
    for (const criterion of state.criteria) lines.push(criterionLine(criterion, cfg.language))
    lines.push('', zh
      ? '下一步：`acceptance check` 真的执行 cmd / 检查 file；manual 需要人工确认。'
      : 'Next: run `acceptance check` to execute cmd checks and stat files; manual criteria need human confirmation.')
    return buildValue({ action: 'define', ok: true, text: lines.join('\n'), criteria: state.criteria })
  }

  async function checkCriteria(state, exec, input) {
    const override = num(input?.timeout_ms, 0, { min: 0, max: 3_600_000 })
    const shell = /** @type {any} */ (ctx).shell
    for (const criterion of state.criteria) {
      // manual 不假装自动验证：保持 pending，等人在收尾汇报里确认。
      if (criterion.type === 'manual') continue
      const outcome = criterion.type === 'cmd'
        ? await checkCommand(criterion, {
          shell,
          agent: exec?.agent,
          signal: exec?.signal,
          timeoutMs: override,
        })
        : await checkFile(criterion)
      criterion.status = outcome.status
      criterion.evidence = truncate(outcome.evidence, MAX_EVIDENCE_CHARS)
      criterion.checkedAt = new Date().toISOString()
    }
    await queueSave(state)
    const zh = cfg.language !== 'en'
    if (state.criteria.length === 0) {
      return buildValue({
        action: 'check',
        ok: true,
        text: zh ? '没有可检查的验收标准；先 acceptance define。' : 'No criteria to check; run acceptance define first.',
        criteria: state.criteria,
      })
    }
    const counts = countCriteria(state.criteria)
    return buildValue({
      action: 'check',
      ok: counts.failed === 0,
      text: checkText({ language: cfg.language, criteria: state.criteria }),
      criteria: state.criteria,
    })
  }

  function listCriteria(state) {
    return buildValue({
      action: 'list',
      ok: true,
      text: listText({ language: cfg.language, criteria: state.criteria }),
      criteria: state.criteria,
    })
  }

  async function completeCriteria(state) {
    const unverified = unverifiedOf(state.criteria)
    const counts = countCriteria(state.criteria)
    const zh = cfg.language !== 'en'
    if (unverified.length > 0) {
      return buildValue({
        action: 'complete',
        ok: false,
        text: refusalText({ language: cfg.language, unverified, total: counts.total }),
        criteria: state.criteria,
        unverified: unverified.slice(0, 5).map(criterion => criterion.text),
      })
    }
    if (counts.total === 0) {
      return buildValue({
        action: 'complete',
        ok: true,
        text: zh ? '当前没有验收标准（空清单）。需要验收就先 acceptance define。' : 'No criteria defined (empty list). Define some via acceptance define if verification is needed.',
        criteria: state.criteria,
      })
    }
    const lines = [zh
      ? `全部 ${counts.total} 条验收标准已通过，可以收尾。`
      : `All ${counts.total} acceptance criteria passed; you may finish.`]
    for (const criterion of state.criteria) lines.push(criterionLine(criterion, cfg.language))
    return buildValue({ action: 'complete', ok: true, text: lines.join('\n'), criteria: state.criteria })
  }

  async function clearCriteria(state) {
    const removed = state.criteria.length
    state.criteria = []
    await queueSave(state)
    const zh = cfg.language !== 'en'
    return buildValue({
      action: 'clear',
      ok: true,
      text: zh ? `已清空 ${removed} 条验收标准。` : `Cleared ${removed} acceptance criteria.`,
      criteria: state.criteria,
    })
  }

  /**
   * 执行一条 cmd 标准。
   *
   * 所有失败路径（shell 缺失 / resolve 抛错 / execute 抛错 / 超时 / 中止 / 非预期
   * 退出码）都收敛成 `{ status: 'failed', evidence }`，绝不把异常抛给宿主。
   */
  async function checkCommand(criterion, { shell, agent, signal, timeoutMs }) {
    if (!shell || typeof shell.resolve !== 'function' || typeof shell.execute !== 'function') {
      return { status: 'failed', evidence: '当前 profile 没有挂载 shell 执行器，命令未执行' }
    }
    const limit = timeoutMs > 0
      ? timeoutMs
      : num(criterion.timeoutMs, cfg.timeoutMs, { min: 1000, max: 3_600_000 })
    try {
      const spec = shell.resolve({
        command: criterion.command,
        timeoutMs: limit,
        signal,
        sandboxPolicy: resolveSandbox(agent),
      })
      const handle = await shell.execute(spec)
      if (!handle || typeof handle.result !== 'function') {
        return { status: 'failed', evidence: 'shell.execute 没有返回可等待的 handle' }
      }
      const result = await handle.result()
      const exitCode = typeof result?.exitCode === 'number' ? result.exitCode : -1
      if (result?.timedOut) return { status: 'failed', evidence: `超时（>${limit}ms）` }
      if (result?.aborted) return { status: 'failed', evidence: '已中止（aborted）' }
      if (exitCode === criterion.expectExitCode) {
        return { status: 'verified', evidence: `exit ${exitCode}` }
      }
      const tail = truncate(
        (readStream(result?.stderr) || readStream(result?.stdout)).replace(/\s+/g, ' ').trim(),
        120,
      )
      return {
        status: 'failed',
        evidence: `exit ${exitCode}（期望 ${criterion.expectExitCode}）${tail ? `：${tail}` : ''}`,
      }
    } catch (error) {
      return { status: 'failed', evidence: `命令执行异常：${truncate(messageOf(error), 120)}` }
    }
  }

  function resolveSandbox(agent) {
    try {
      const policy = /** @type {any} */ (ctx).sandboxPolicy
      if (!policy || typeof policy.resolve !== 'function') return undefined
      return policy.resolve({ session: agent?.session })
    } catch {
      return undefined
    }
  }

  // ── 持久化 ──────────────────────────────────────────────────────────────

  async function loadState(state) {
    const data = await store.load(state.key, null)
    if (!data || data.version !== 1) return
    if (Array.isArray(data.criteria)) {
      state.criteria = data.criteria
        .map(sanitizeStoredCriterion)
        .filter(Boolean)
        .slice(0, cfg.maxCriteria)
    }
    state.nudges = num(data.nudges, 0, { min: 0, max: 10 })
    state.turn = num(data.turn, 0, { min: 0 })
  }

  /** 排到写链末尾；调用方 await 它即可保证「结果返回前已落盘」。 */
  function queueSave(state) {
    if (!state.key) return Promise.resolve()
    const key = state.key
    writeChain = writeChain
      .then(async () => {
        await state.ready
        await store.save(key, {
          version: 1,
          criteria: state.criteria.map(criterion => ({ ...criterion })),
          nudges: state.nudges,
          turn: state.turn,
          updatedAt: new Date().toISOString(),
        })
      })
      .catch(error => {
        logger.warn('保存验收标准失败：', messageOf(error))
      })
    return writeChain
  }
}

// ── 状态与配置 ────────────────────────────────────────────────────────────

function createState(key = '') {
  return {
    key,
    /** @type {Array<any>} */
    criteria: [],
    nudges: 0,
    turn: 0,
    /** 本回合是否已经注入过待办快照。 */
    notifiedTurn: false,
    /** 加载磁盘状态的 promise；工具/事件先 await 它。 */
    ready: Promise.resolve(),
    loaded: false,
  }
}

function normalize(raw, logger) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const normalized = {
    enabled: bool(input.enabled, DEFAULTS.enabled),
    gate: bool(input.gate, DEFAULTS.gate),
    maxNudges: num(input.maxNudges, DEFAULTS.maxNudges, { min: 0, max: 10 }),
    language: str(input.language, DEFAULTS.language) === 'en' ? 'en' : 'zh',
    maxCriteria: num(input.maxCriteria, DEFAULTS.maxCriteria, { min: 1, max: 200 }),
    timeoutMs: num(input.timeoutMs, DEFAULTS.timeoutMs, { min: 1000, max: 3_600_000 }),
    dir: str(input.dir, '').trim() || v41Dir('acceptance'),
  }
  if (!str(input.dir, '').trim()) logger.debug(`使用默认存储目录 ${normalized.dir}`)
  return normalized
}

/** 回合切换：重置每回合一次的催办与注入标记。 */
function syncTurn(state, turn) {
  if (typeof turn !== 'number' || !Number.isFinite(turn)) return
  if (turn === state.turn) return
  state.turn = turn
  state.nudges = 0
  state.notifiedTurn = false
}

// ── 纯函数：标准解析 / 统计 / 渲染 ────────────────────────────────────────

function countCriteria(criteria) {
  const counts = { total: criteria.length, verified: 0, failed: 0, pending: 0 }
  for (const criterion of criteria) {
    if (criterion.status === 'verified') counts.verified += 1
    else if (criterion.status === 'failed') counts.failed += 1
    else counts.pending += 1
  }
  return counts
}

function unverifiedOf(criteria) {
  return criteria.filter(criterion => criterion.status !== 'verified')
}

function parseCriterion(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`criteria[${index}] 必须是对象。`)
  }
  const text = str(raw.text, '').trim()
  if (!text) throw new Error(`criteria[${index}] 缺少 text（每条验收标准都要有一句可读的描述）。`)
  const type = raw.type === undefined || raw.type === null || raw.type === ''
    ? 'cmd'
    : str(raw.type, '').trim()
  if (!CRITERION_TYPES.has(type)) {
    throw new Error(`criteria[${index}].type 必须是 cmd | file | manual，收到 "${type}"。`)
  }
  const criterion = {
    id: makeId('acc'),
    text: truncate(text, 300),
    type,
    status: 'pending',
    evidence: '',
    checkedAt: null,
    expectExitCode: 0,
    timeoutMs: DEFAULTS.timeoutMs,
  }
  if (type === 'cmd') {
    const command = str(raw.command, '').trim()
    if (!command) {
      throw new Error(`criteria[${index}] 的 type 是 cmd，必须给 command（做文件检查请显式写 type: 'file'）。`)
    }
    criterion.command = truncate(command, 500)
    criterion.expectExitCode = num(raw.expect_exit_code ?? raw.expectExitCode, 0, { min: -255, max: 255 })
    criterion.timeoutMs = num(raw.timeout_ms ?? raw.timeoutMs, DEFAULTS.timeoutMs, { min: 1000, max: 3_600_000 })
  }
  if (type === 'file') {
    const target = str(raw.path, '').trim()
    if (!target) throw new Error(`criteria[${index}] 的 type 是 file，必须给 path。`)
    criterion.path = truncate(target, 500)
  }
  return criterion
}

/** 磁盘上的旧状态只信任形状正确的条目；损坏的条目直接丢弃。 */
function sanitizeStoredCriterion(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const text = str(raw.text, '').trim()
  if (!text) return null
  const type = CRITERION_TYPES.has(raw.type) ? raw.type : 'cmd'
  const criterion = {
    id: str(raw.id, '').trim() || makeId('acc'),
    text: truncate(text, 300),
    type,
    status: raw.status === 'verified' || raw.status === 'failed' ? raw.status : 'pending',
    evidence: truncate(str(raw.evidence, ''), MAX_EVIDENCE_CHARS),
    checkedAt: typeof raw.checkedAt === 'string' && raw.checkedAt ? raw.checkedAt : null,
    expectExitCode: num(raw.expectExitCode, 0, { min: -255, max: 255 }),
    timeoutMs: num(raw.timeoutMs, DEFAULTS.timeoutMs, { min: 1000, max: 3_600_000 }),
  }
  if (type === 'cmd') {
    const command = str(raw.command, '').trim()
    if (!command) return null
    criterion.command = truncate(command, 500)
  }
  if (type === 'file') {
    const target = str(raw.path, '').trim()
    if (!target) return null
    criterion.path = truncate(target, 500)
  }
  return criterion
}

function targetOf(criterion) {
  if (criterion.type === 'cmd') return `\`${criterion.command ?? ''}\``
  if (criterion.type === 'file') return `\`${criterion.path ?? ''}\``
  return 'manual'
}

function criterionBrief(criterion, language) {
  const zh = language !== 'en'
  const expected = criterion.type === 'cmd' && criterion.expectExitCode !== 0
    ? (zh ? `，期望 exit ${criterion.expectExitCode}` : `, expect exit ${criterion.expectExitCode}`)
    : ''
  const manual = criterion.type === 'manual' ? (zh ? '（人工确认）' : ' (manual)') : ''
  return `[${criterion.type}] ${criterion.text} → ${targetOf(criterion)}${expected}${manual}`
}

function criterionLine(criterion, language) {
  const zh = language !== 'en'
  const icon = STATUS_ICONS[criterion.status] ?? '·'
  const labels = zh ? STATUS_LABELS.zh : STATUS_LABELS.en
  const label = labels[criterion.status] ?? criterion.status
  const evidence = criterion.evidence
    ? (zh ? `；证据：${criterion.evidence}` : `; evidence: ${criterion.evidence}`)
    : ''
  return `${icon} [${criterion.type}] ${criterion.text}（${targetOf(criterion)}，${label}）${evidence}`
}

function listText({ language, criteria }) {
  const zh = language !== 'en'
  if (criteria.length === 0) {
    return zh
      ? '还没有定义验收标准。用 `acceptance` define 写入 criteria（text 必填；type=cmd 需 command，type=file 需 path）。'
      : 'No acceptance criteria yet. Use `acceptance` define (text required; cmd needs command, file needs path).'
  }
  const counts = countCriteria(criteria)
  const lines = [zh
    ? `验收标准（${counts.verified}/${counts.total} 已通过）`
    : `Acceptance criteria (${counts.verified}/${counts.total} passed)`]
  for (const criterion of criteria) lines.push(criterionLine(criterion, language))
  const open = counts.total - counts.verified
  lines.push('', open === 0
    ? (zh ? '全部通过，可以 `acceptance complete`。' : 'All passed; you can run `acceptance complete`.')
    : (zh ? `还有 ${open} 条未通过：先 \`acceptance check\` 补执行证据。` : `${open} unverified: run \`acceptance check\` for evidence.`))
  return lines.join('\n')
}

function checkText({ language, criteria }) {
  const zh = language !== 'en'
  const counts = countCriteria(criteria)
  const lines = [zh
    ? `检查完成：${counts.verified} 条通过，${counts.failed} 条失败，${counts.pending} 条待验证。`
    : `Check finished: ${counts.verified} passed, ${counts.failed} failed, ${counts.pending} pending.`]
  for (const criterion of criteria) lines.push(criterionLine(criterion, language))
  if (counts.failed > 0) {
    lines.push('', zh
      ? `下一步：修掉这 ${counts.failed} 个失败项，然后重新 \`acceptance check\`。`
      : `Next: fix the ${counts.failed} failed item(s), then run \`acceptance check\` again.`)
  } else if (counts.pending > 0) {
    lines.push('', zh
      ? '剩下的 manual 标准需要人工确认，当前仍记为待验证。'
      : 'Remaining manual criteria need human confirmation; they stay pending.')
  } else {
    lines.push('', zh ? '全部通过，可以 `acceptance complete`。' : 'All passed; you can run `acceptance complete`.')
  }
  return lines.join('\n')
}

function refusalText({ language, unverified, total }) {
  const zh = language !== 'en'
  const shown = unverified.slice(0, 5)
  const lines = [zh
    ? `complete 被拒绝：还有 ${unverified.length}/${total} 条验收标准未验证。`
    : `complete refused: ${unverified.length}/${total} acceptance criteria are unverified.`]
  for (const criterion of shown) lines.push(`- ${criterionBrief(criterion, language)}`)
  if (unverified.length > shown.length) {
    lines.push(zh ? `- 另有 ${unverified.length - shown.length} 条…` : `- ${unverified.length - shown.length} more…`)
  }
  lines.push('', zh
    ? '现在只做一件：`acceptance check` 拿真实结果；确实做不了就说明哪条卡住、缺什么——不要宣称完成。'
    : 'Do one thing: run `acceptance check` for real evidence; if blocked, name the criterion and the blocker — do not claim completion.')
  return lines.join('\n')
}

function pendingCard({ language, pending, total }) {
  const zh = language !== 'en'
  const shown = pending.slice(0, 5)
  const lines = [zh
    ? `## 待办验收标准（${pending.length}/${total} 未验证）`
    : `## Open acceptance criteria (${pending.length}/${total} unverified)`]
  for (const criterion of shown) lines.push(`- ${criterionBrief(criterion, language)}`)
  if (pending.length > shown.length) {
    lines.push(zh ? `- 另有 ${pending.length - shown.length} 条…` : `- ${pending.length - shown.length} more…`)
  }
  lines.push(zh
    ? '收尾前先 `acceptance check`，全绿后 `acceptance complete`。'
    : 'Run `acceptance check` before finishing; then `acceptance complete` once green.')
  lines.push('', sourceNote(language))
  return lines.join('\n')
}

function gateNudge({ language, pending, total }) {
  const zh = language !== 'en'
  const shown = pending.slice(0, 5)
  const lines = [zh
    ? `验收未通过：${pending.length}/${total} 条标准还没有验证。`
    : `Acceptance not met: ${pending.length}/${total} criteria are still unverified.`]
  for (const criterion of shown) lines.push(`- ${criterionBrief(criterion, language)}`)
  if (pending.length > shown.length) {
    lines.push(zh ? `- 另有 ${pending.length - shown.length} 条…` : `- ${pending.length - shown.length} more…`)
  }
  lines.push(zh
    ? '现在只做其中一件：1) `acceptance check` 拿真实结果；2) 全通过后 `acceptance complete`；3) 做不了就说明哪条卡住、缺什么——不要谎称完成。'
    : 'Do exactly one: 1) run `acceptance check`; 2) `complete` after all pass; 3) if blocked, name the criterion and the gap — never claim completion.')
  lines.push('', sourceNote(language))
  return lines.join('\n')
}

function buildValue({ action, ok, text, criteria, unverified = [] }) {
  return {
    ok,
    action,
    text,
    criteria: criteria.map(criterion => ({
      id: criterion.id,
      text: criterion.text,
      type: criterion.type,
      status: criterion.status,
      evidence: criterion.evidence ?? '',
      checkedAt: criterion.checkedAt ?? '',
    })),
    counts: countCriteria(criteria),
    unverified,
  }
}

function buildToolDescription(cfg) {
  return [
    '管理本会话的可执行验收标准：define / check / list / complete / clear。',
    '- define：每条 text 必填；type=cmd（默认）要 command，type=file 要 path，type=manual 需人工确认。默认追加，replace:true 替换。',
    `- check：真的执行 cmd（经 shell）并检查 file 是否存在且非空；manual 保持待验证。最多 ${cfg.maxCriteria} 条，单条超时默认 ${Math.round(cfg.timeoutMs / 1000)}s。`,
    '- complete：只有全部 verified 才成功；否则返回未验证项（≤5 条）。',
    '- clear：清空本会话的标准。',
    '规则：没有 check 产生的退出码/文件证据，就不要宣称完成。',
  ].join('\n')
}

// ── 杂项 ──────────────────────────────────────────────────────────────────

async function checkFile(criterion) {
  const target = path.resolve(criterion.path)
  try {
    const info = await fsp.stat(target)
    if (!info.isFile()) return { status: 'failed', evidence: `${target} 不是普通文件` }
    if (info.size <= 0) return { status: 'failed', evidence: `${target} 是空文件（0 字节）` }
    return { status: 'verified', evidence: `${target}（${info.size} 字节）` }
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'failed', evidence: `文件不存在：${target}` }
    return { status: 'failed', evidence: `无法读取 ${target}：${truncate(messageOf(error), 120)}` }
  }
}

function readStream(stream) {
  if (!stream) return ''
  if (typeof stream === 'string') return stream
  if (typeof stream.text === 'string') return stream.text
  return ''
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
