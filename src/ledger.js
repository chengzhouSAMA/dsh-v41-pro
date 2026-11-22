/**
 * v41pro-ledger —— 状态外置台账。
 *
 * 解决的问题：Flash 的失败模式不是「忘了事实」，而是「忘了自己在干嘛」。
 * 上下文一长、一压缩，它就开始重做已经失败过的动作。Pro 靠参数记得住主线，
 * Flash 记不住 —— 那就把主线写到磁盘上，定期重注入。
 *
 * 记录什么：本轮目标、改过哪些文件（各几次）、哪些做法失败过、最近跑了哪些
 * 命令。注入形态用 `snapshot`（后一份取代前一份），不是 `notice` —— 现状每
 * 次都是全量的，不是事件流。
 *
 * 存储位置：`$DSH_HOME/v41pro/ledger/<sessionId>.json`，默认 `~/.dsh/...`。
 * 刻意不写进用户的工作目录：这是插件的私有状态，不该出现在 git status 里。
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { bool, makeLogger, num, str } from './core/config.js'
import { createAgentStore, boundedPush, sessionKey } from './core/state.js'
import { createSnapshot } from './core/message.js'
import { blocksToText, extractCommand, extractPath, truncate } from './core/util.js'
import { ledgerCard } from './core/text.js'
import { assessCommandResult, failureSummary, redactSecrets } from './core/evidence.js'

export const name = 'v41pro-ledger'

export const inject = ['tools']

export const DEFAULTS = {
  enabled: true,
  /** 每多少步重注入一次现状卡（回合开头总会注入一次）。 */
  everySteps: 6,
  /** 卡里最多列几个文件 / 几条失败 / 几条命令。 */
  maxFiles: 6,
  maxFailures: 4,
  maxCommands: 5,
  /** 是否落盘。关掉就只在内存里记。 */
  persist: true,
  /** 存储目录；空表示 `$DSH_HOME/v41pro/ledger`。 */
  dir: '',
  language: 'zh',
  /** 判定「写文件」的工具名正则。 */
  editTools: 'write|edit|patch|apply|create_file|notebook',
  /** 判定「执行命令」的工具名正则。 */
  commandTools: 'bash|pwsh|shell|exec|command|terminal',
  /** 单条失败摘要的最大字符数。 */
  failureChars: 160,
}

/** 一轮对话之外的持久字段。 */
function createState(key) {
  return {
    key,
    tick: 0,
    lastCardTick: -1_000_000,
    goal: '',
    /** @type {Map<string, { count: number, at: number }>} */
    files: new Map(),
    /** @type {Array<{ tool: string, message: string, at: number }>} */
    failures: [],
    /** @type {Array<{ command: string, ok: boolean, at: number }>} */
    commands: [],
    loaded: false,
    dirty: false,
    saveVersion: 0,
    goalTurn: -1,
    ready: Promise.resolve(),
    turn: 0,
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
    logger.info('enabled=false，台账已关闭')
    return
  }

  const states = createAgentStore(agent => createState(sessionKey(agent)))
  const store = new LedgerStore(cfg, logger)
  /** @type {Promise<void>} */
  let writeChain = Promise.resolve()

  // ── 会话建立：从磁盘恢复 ────────────────────────────────────────────────
  // 刻意不 await：cordis 会等这个监听器 settle 之后才完成 agent 创建，读盘
  // 同步阻塞会把每个新会话的启动都拖慢一次。台账晚到几十毫秒没有影响。
  ctx.on('agent/created', ({ agent }) => {
    const state = states.get(agent)
    if (!cfg.persist || !state.key) {
      state.loaded = true
      return
    }
    state.ready = store.load(state)
      .catch(error => logger.warn('读取台账失败，按空台账继续：', error instanceof Error ? error.message : error))
      .finally(() => {
        state.loaded = true
      })
  })

  // ── 记录：工具结果 ──────────────────────────────────────────────────────
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    try {
      const agent = exec?.agent
      if (agent) {
        const state = states.get(agent)
        await state.ready
        record(state, exec, result, cfg)
      }
    } catch (error) {
      logger.warn('台账记录失败：', error instanceof Error ? error.message : error)
    }
    return downstream
  })

  // ── 注入：每步检查是否该重注入现状卡 ────────────────────────────────────
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    let card
    try {
      if (decision?.kind === 'enter') {
        const state = states.get(payload.agent)
        await state.ready
        state.tick += 1
        state.turn = payload.turn
        captureGoal(state, payload.messages)
        queueSave(state)
        if (due(state, cfg)) {
          state.lastCardTick = state.tick
          card = buildCard(state, payload.step, cfg)
        }
      }
    } catch (error) {
      logger.warn('台账注入失败：', error instanceof Error ? error.message : error)
    }
    if (!card) return decision
    // 放在最前面：现状卡先于本轮用户消息被读到。
    return { ...decision, messages: [card, ...decision.messages] }
  })

  // ── 会话销毁：刷盘 ──────────────────────────────────────────────────────
  ctx.on('agent/disposed', async ({ agent }) => {
    const state = states.peek(agent)
    if (!state) return
    queueSave(state)
    try {
      await writeChain
    } catch {
      // queueSave 已记录失败，销毁路径不能向外抛错。
    }
    states.delete(agent)
  })

  // ── 内部 ────────────────────────────────────────────────────────────────

  function record(state, exec, result, config) {
    const tool = String(exec.name ?? '')
    const failed = !assessCommandResult(result).ok
    const at = Date.now()

    if (config.editRe.test(tool) && !failed) {
      const file = extractPath(exec.arguments)
      if (file) {
        const entry = state.files.get(file)
        state.files.set(file, { count: (entry?.count ?? 0) + 1, at })
        if (state.files.size > 64) {
          const oldest = [...state.files.entries()].sort((a, b) => a[1].at - b[1].at)[0]
          if (oldest) state.files.delete(oldest[0])
        }
        markDirty(state)
      }
    }

    if (config.commandRe.test(tool)) {
      const command = extractCommand(exec.arguments)
      if (command) {
        boundedPush(state.commands, {
          command: truncate(redactSecrets(command), 120),
          ok: assessCommandResult(result).ok,
          at,
        }, config.maxCommands)
        markDirty(state)
      }
    }

    if (failed) {
      const message = failureSummary(result, config.failureChars)
      boundedPush(state.failures, { tool, message, at }, config.maxFailures)
      markDirty(state)
    }

    queueSave(state)
  }

  function markDirty(state) {
    state.dirty = true
    state.saveVersion += 1
  }

  function queueSave(state) {
    if (!state.dirty || !cfg.persist || !state.key) return
    writeChain = writeChain
      .then(() => store.save(state))
      .catch(error => logger.warn('保存台账失败：', error instanceof Error ? error.message : error))
  }

  function captureGoal(state, messages) {
    if (!Array.isArray(messages)) return
    for (const message of messages) {
      if (message?.source?.kind !== 'user') continue
      const text = blocksToText(message.content).replace(/\s+/g, ' ').trim()
      if (text && (!state.goal || state.goalTurn !== state.turn)) {
        state.goal = truncate(text, 300)
        state.goalTurn = state.turn
        markDirty(state)
        return
      }
    }
  }

  /**
   * 是否该重注入。
   *
   * 刚开会话时台账基本是空的（只有目标），注一张只有目标的卡是纯噪音，所以
   * 必须有「历史」——改过文件、失败过、跑过命令——才允许注入。
   */
  function due(state, config) {
    const hasHistory = state.files.size > 0 || state.failures.length > 0 || state.commands.length > 0
    if (!hasHistory) return false
    return state.lastCardTick < 0 || state.tick - state.lastCardTick >= config.everySteps
  }

  function buildCard(state, step, config) {
    const files = [...state.files.entries()]
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, config.maxFiles)
      .map(([file, entry]) => ({ path: file, count: entry.count }))
    const failures = state.failures.slice(-config.maxFailures)
    const commands = state.commands.slice(-config.maxCommands)

    const text = ledgerCard({
      language: config.language,
      goal: state.goal,
      files,
      failures,
      commands,
      step,
    })

    return createSnapshot({
      kind: 'v41pro-ledger',
      text,
      sections: [
        ...(state.goal ? [{ name: 'goal', text: state.goal }] : []),
        ...(files.length ? [{ name: 'files', text: files.map(f => `${f.path} ×${f.count}`).join('\n') }] : []),
        ...(failures.length ? [{ name: 'failures', text: failures.map(f => `${f.tool}: ${f.message}`).join('\n') }] : []),
        ...(commands.length ? [{ name: 'commands', text: commands.map(c => `${c.ok ? 'ok' : 'fail'} ${c.command}`).join('\n') }] : []),
      ],
    })
  }
}

/** 磁盘读写。写入走「临时文件 + rename」，避免进程被杀时留下半个 JSON。 */
class LedgerStore {
  constructor(cfg, logger) {
    this.cfg = cfg
    this.logger = logger
    this.dir = cfg.dir || defaultDir()
  }

  fileFor(key) {
    const safe = String(key).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
    return path.join(this.dir, `${safe || 'session'}.json`)
  }

  async load(state) {
    const file = this.fileFor(state.key)
    let raw
    try {
      raw = await fsp.readFile(file, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    const data = JSON.parse(raw)
    if (data?.version !== 1) return
    if (typeof data.goal === 'string') state.goal = data.goal
    if (data.files && typeof data.files === 'object') {
      for (const [name, entry] of Object.entries(data.files)) {
        if (entry && typeof entry === 'object') {
          state.files.set(name, { count: Number(entry.count) || 1, at: Number(entry.at) || 0 })
        }
      }
    }
    if (Array.isArray(data.failures)) {
      for (const failure of data.failures.slice(-this.cfg.maxFailures)) {
        if (failure && typeof failure === 'object') {
          state.failures.push({
            tool: String(failure.tool ?? ''),
            message: String(failure.message ?? ''),
            at: Number(failure.at) || 0,
          })
        }
      }
    }
    if (Array.isArray(data.commands)) {
      for (const command of data.commands.slice(-this.cfg.maxCommands)) {
        if (command && typeof command === 'object') {
          state.commands.push({
            command: String(command.command ?? ''),
            ok: command.ok === true,
            at: Number(command.at) || 0,
          })
        }
      }
    }
  }

  async save(state) {
    if (!this.dir) return
    const revision = state.saveVersion
    const file = this.fileFor(state.key)
    // 必须在第一次 await 前抓取快照，否则等待期间的新写入会混入旧保存任务。
    const payload = {
      version: 1,
      session: state.key,
      updatedAt: Date.now(),
      goal: state.goal,
      files: Object.fromEntries(state.files),
      failures: state.failures,
      commands: state.commands,
    }
    await fsp.mkdir(this.dir, { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(payload), 'utf8')
    await fsp.rename(tmp, file)
    state.dirty = state.saveVersion !== revision
  }
}

function defaultDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'v41pro', 'ledger')
}

function normalize(raw, logger) {
  const config = raw && typeof raw === 'object' ? raw : {}
  const normalized = {
    enabled: bool(config.enabled, DEFAULTS.enabled),
    everySteps: num(config.everySteps, DEFAULTS.everySteps, { min: 1 }),
    maxFiles: num(config.maxFiles, DEFAULTS.maxFiles, { min: 1 }),
    maxFailures: num(config.maxFailures, DEFAULTS.maxFailures, { min: 1 }),
    maxCommands: num(config.maxCommands, DEFAULTS.maxCommands, { min: 1 }),
    persist: bool(config.persist, DEFAULTS.persist),
    dir: str(config.dir, DEFAULTS.dir),
    language: str(config.language, DEFAULTS.language) === 'en' ? 'en' : 'zh',
    editTools: str(config.editTools, DEFAULTS.editTools),
    commandTools: str(config.commandTools, DEFAULTS.commandTools),
    failureChars: num(config.failureChars, DEFAULTS.failureChars, { min: 20 }),
  }
  normalized.editRe = compile(normalized.editTools, DEFAULTS.editTools, 'editTools', logger)
  normalized.commandRe = compile(normalized.commandTools, DEFAULTS.commandTools, 'commandTools', logger)
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

/** 供测试使用：把内存状态导出成可断言的纯对象。 */
export function __debugState(state) {
  return {
    goal: state.goal,
    files: [...state.files.entries()],
    failures: [...state.failures],
    commands: [...state.commands],
  }
}

/** 供测试使用：直接构造一个状态。 */
export function __createState(key = 'test') {
  return createState(key)
}

/** 供测试使用：清理某个会话的落盘文件。 */
export function __removeSessionFile(key, dir = defaultDir()) {
  const safe = String(key).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
  try {
    fs.rmSync(path.join(dir, `${safe || 'session'}.json`), { force: true })
  } catch {
    /* ignore */
  }
}
