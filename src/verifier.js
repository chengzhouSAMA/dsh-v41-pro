/**
 * v41pro-verifier —— 验证闸门。
 *
 * 一条规则，没有例外：
 *
 *      「完成了」不能由模型宣布，只能由验证器宣布。
 *
 * Flash 最大的事故类别不是答错，而是**以为自己改对了**。这个插件做两件事：
 *
 *  1. `pro_verify` 工具：通过 `ctx.shell`（沙箱内执行器，和 bash 工具同一条
 *     路径）真正跑一条命令，把 exit code 和输出尾部交回来。
 *  2. 收尾闸门：监听 `agent/turn-stopping`。如果本轮改过文件，而之后的验证
 *     没有成功过，就 `agent.steer()` 把回合续命一次，要求它先验证。
 *     只续一次 —— 插件不该变成无法结束的循环。
 *
 * 「验证」有两类来源：显式调用 `pro_verify`；或者模型自己用 bash 跑了能匹配
 * `verifyPatterns` 的命令（pnpm test / pytest / tsc / cargo check …）且退出 0。
 * 后者很重要：多数模型本来就会跑测试，不该强迫它换一个工具再说一遍。
 */

import { bool, makeLogger, num, str, strList } from './core/config.js'
import { createAgentStore } from './core/state.js'
import { createNotice } from './core/message.js'
import { extractCommand, extractPath, truncate } from './core/util.js'
import { verifyNudge } from './core/text.js'
import { assessCommandResult, requiresTestEvidence } from './core/evidence.js'

export const name = 'v41pro-verifier'

/** shell 提供沙箱执行器；没有它本插件无法验证任何东西，应当休眠。 */
export const inject = ['tools', 'shell']

export const DEFAULTS = {
  enabled: true,
  /** 是否启用收尾闸门。false 时只提供 pro_verify 工具。 */
  gate: true,
  /** 一轮里最多催几次去验证。 */
  maxNudges: 1,
  /** 预置的验证命令（会出现在工具描述和催促文案里）。 */
  commands: [],
  /** 认为是「验证行为」的命令正则（模型用 bash 自己跑也算数）。 */
  verifyPatterns: [
    '\\bpytest\\b', '\\bmake test\\b', '\\bnode\\s+[^\\n;&|]*--test\\b', '\\bvitest\\b', '\\bjest\\b', '\\btsc\\b', '\\bcargo (check|test|build)\\b',
    '\\bgo (test|build|vet)\\b', '\\b(dotnet|mvn|gradle) (test|build)\\b', '\\bnpm run (test|lint|typecheck)\\b',
    '\\bpnpm (run )?(test|lint|typecheck)\\b', '\\byarn (test|lint)\\b', '\\bruff\\b', '\\beslint\\b', '\\btypecheck\\b',
  ],
  /** 判定「写文件」的工具名正则。 */
  editTools: 'write|edit|patch|apply|create_file|notebook',
  /** 判定「跑命令」的工具名正则。 */
  commandTools: 'bash|pwsh|shell|exec|command|terminal',
  /** 单条输出保留的最大字符数。 */
  outputChars: 4000,
  /** 默认超时。 */
  timeoutMs: 300_000,
  language: 'zh',
}

function createState() {
  return {
    turn: 0,
    step: 0,
    ops: 0,
    lastMutationOp: 0,
    /** @type {{ op: number, ok: boolean, label: string } | null} */
    lastVerify: null,
    /** @type {string[]} */
    mutatedThisTurn: [],
    nudgesThisTurn: 0,
    /** 本回合是否已经因为「验证失败」被催过。 */
    verifiedThisTurn: false,
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
    logger.info('enabled=false，验证闸门已关闭')
    return
  }

  const states = createAgentStore(createState)

  // ── 步边界 ──────────────────────────────────────────────────────────────
  ctx.on('agent/pre-step', async (payload, next) => {
    try {
      const state = states.get(payload.agent)
      if (payload.turn !== state.turn) {
        state.turn = payload.turn
        state.mutatedThisTurn = []
        state.nudgesThisTurn = 0
        state.verifiedThisTurn = false
      }
      state.step = payload.step
    } catch (error) {
      logger.warn('pre-step 观测失败：', error instanceof Error ? error.message : error)
    }
    return next()
  })

  // ── 观测工具结果 ────────────────────────────────────────────────────────
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    try {
      if (exec?.agent) observe(states.get(exec.agent), exec, result, cfg, logger)
    } catch (error) {
      logger.warn('验证观测失败：', error instanceof Error ? error.message : error)
    }
    return downstream
  })

  // ── 收尾闸门 ────────────────────────────────────────────────────────────
  ctx.on('agent/turn-stopping', ({ agent }) => {
    if (!cfg.gate) return
    try {
      const state = states.get(agent)
      if (state.mutatedThisTurn.length === 0) return
      const verified = state.lastVerify && state.lastVerify.op > state.lastMutationOp && state.lastVerify.ok
      if (verified) return
      if (state.nudgesThisTurn >= cfg.maxNudges) {
        logger.warn(`本轮已催过 ${state.nudgesThisTurn} 次验证，放行收尾`)
        return
      }
      state.nudgesThisTurn += 1
      logger.info(`收尾拦截：改动 ${state.mutatedThisTurn.length} 个文件但未验证`)
      agent.steer(createNotice({
        kind: 'v41pro-verifier',
        summary: '未验证就收尾',
        text: verifyNudge({
          language: cfg.language,
          files: state.mutatedThisTurn,
          commands: cfg.commands,
          lastVerify: state.lastVerify ? `${state.lastVerify.label}（${state.lastVerify.ok ? '通过' : '失败'}）` : '',
        }),
      }))
    } catch (error) {
      logger.warn('收尾闸门失败：', error instanceof Error ? error.message : error)
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    states.delete(agent)
  })

  // ── pro_verify 工具 ─────────────────────────────────────────────────────
  ctx.effect(() => {
    const disposer = ctx.tools.register({
      name: 'pro_verify',
      description: buildToolDescription(cfg),
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: '要执行的验证命令。留空则使用配置里的第一条预置命令。',
          },
          label: {
            type: 'string',
            description: '这次验证的短标签，例如 "unit tests"。会记进台账。',
          },
          timeout_ms: {
            type: 'number',
            description: '超时毫秒数；默认取插件配置。',
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            exitCode: { type: 'integer' },
            timedOut: { type: 'boolean' },
            command: { type: 'string' },
            stdout: { type: 'string' },
            stderr: { type: 'string' },
          },
          required: ['ok', 'exitCode', 'timedOut', 'command', 'stdout', 'stderr'],
          additionalProperties: false,
        },
        render(_args, value) {
          const head = value.ok
            ? `✅ 验证通过（exit ${value.exitCode}）：\`${value.command}\``
            : `❌ 验证失败（${value.timedOut ? '超时' : `exit ${value.exitCode}`}）：\`${value.command}\``
          const parts = [head]
          if (value.stdout) parts.push('', '--- stdout ---', value.stdout)
          if (value.stderr) parts.push('', '--- stderr ---', value.stderr)
          return [{ type: 'text', text: parts.join('\n') }]
        },
      },
      async execute(args, exec) {
        const input = args && typeof args === 'object' ? args : {}
        const fallback = cfg.commands[0]?.command ?? ''
        const command = typeof input.command === 'string' && input.command.trim()
          ? input.command.trim()
          : fallback
        if (!command) {
          throw new Error('pro_verify 需要一条 command：既没有传参，也没有配置预置命令。')
        }
        const timeoutMs = num(input.timeout_ms, cfg.timeoutMs, { min: 1000, max: 3_600_000 })
        const shell = /** @type {any} */ (ctx).shell
        if (!shell || typeof shell.resolve !== 'function' || typeof shell.execute !== 'function') {
          throw new Error('当前 profile 没有挂载 shell 执行器，pro_verify 无法运行命令。')
        }

        // 与普通 bash/pwsh 一样，携带当前 Session 的实际策略；缺省由 executor 使用部署默认值。
        const sandboxPolicy = ctx.sandboxPolicy?.resolve({ session: exec?.agent?.session })
        const spec = shell.resolve({ command, timeoutMs, signal: exec?.signal, sandboxPolicy })
        const handle = await shell.execute(spec)
        const result = await handle.result()

        const ok = result.exitCode === 0 && !result.timedOut && !result.aborted
        const value = {
          ok,
          exitCode: typeof result.exitCode === 'number' ? result.exitCode : -1,
          timedOut: Boolean(result.timedOut),
          command,
          stdout: truncate(result.stdout?.text ?? '', cfg.outputChars),
          stderr: truncate(result.stderr?.text ?? '', cfg.outputChars),
        }

        // 记进状态：这一刻就是「最后一次验证」。
        const state = exec?.agent ? states.get(exec.agent) : undefined
        if (state) {
          state.ops += 1
          state.lastVerify = {
            op: state.ops,
            ok,
            label: typeof input.label === 'string' && input.label.trim() ? input.label.trim() : command,
          }
        }
        return value
      },
    })

    return () => {
      try {
        disposer?.()
      } catch {
        /* ignore */
      }
    }
  }, 'v41pro-verifier tool')

  // ── 内部 ────────────────────────────────────────────────────────────────

  function observe(state, exec, result, config, log) {
    const tool = String(exec.name ?? '')
    const failed = result?.isError === true
    state.ops += 1

    // 写文件 → 记为「需要验证的改动」。
    if (config.editRe.test(tool) && !failed) {
      const file = extractPath(exec.arguments)
      if (file) {
        state.lastMutationOp = state.ops
        if (!state.mutatedThisTurn.includes(file)) {
          state.mutatedThisTurn.push(file)
          if (state.mutatedThisTurn.length > 32) state.mutatedThisTurn.shift()
        }
      }
    }

    // 跑命令 → 看它是不是一次验证。
    if (config.commandRe.test(tool)) {
      const command = extractCommand(exec.arguments)
      if (command && config.verifyRes.some(re => re.test(command))) {
        const assessment = assessCommandResult(result, { requireSummary: requiresTestEvidence(command) })
        state.lastVerify = {
          op: state.ops,
          ok: assessment.ok,
          label: `${truncate(command, 100)}（${assessment.reason}）`,
        }
        log.debug(`识别到验证命令：${truncate(command, 60)} → ${assessment.ok ? '通过' : assessment.reason}`)
      }
    }
  }
}

function buildToolDescription(cfg) {
  const lines = [
    '运行一次真实验证并返回 exit code 与输出尾部。',
    '用途：在宣称任务完成之前，用可执行的检查（测试、类型检查、编译、复现脚本）证明它确实成立。',
    '规则：验证的结论以这条工具的 exit code 为准，不以你的判断为准；失败就把输出读到底再改。',
  ]
  if (cfg.commands.length > 0) {
    lines.push('', '已配置的验证命令：')
    for (const command of cfg.commands) {
      lines.push(`- ${command.name}：\`${command.command}\``)
    }
  }
  return lines.join('\n')
}

function normalize(raw, logger) {
  const config = raw && typeof raw === 'object' ? raw : {}
  const commands = Array.isArray(config.commands)
    ? config.commands
        .filter(item => item && typeof item === 'object' && typeof item.command === 'string' && item.command.trim())
        .map(item => ({
          name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : item.command,
          command: item.command.trim(),
          timeoutMs: num(item.timeoutMs, DEFAULTS.timeoutMs, { min: 1000, max: 3_600_000 }),
        }))
    : []

  const patterns = strList(config.verifyPatterns, DEFAULTS.verifyPatterns)
  const normalized = {
    enabled: bool(config.enabled, DEFAULTS.enabled),
    gate: bool(config.gate, DEFAULTS.gate),
    maxNudges: num(config.maxNudges, DEFAULTS.maxNudges, { min: 0 }),
    commands,
    language: str(config.language, DEFAULTS.language) === 'en' ? 'en' : 'zh',
    editTools: str(config.editTools, DEFAULTS.editTools),
    commandTools: str(config.commandTools, DEFAULTS.commandTools),
    outputChars: num(config.outputChars, DEFAULTS.outputChars, { min: 200 }),
    timeoutMs: num(config.timeoutMs, DEFAULTS.timeoutMs, { min: 1000, max: 3_600_000 }),
  }
  normalized.editRe = compile(normalized.editTools, DEFAULTS.editTools, 'editTools', logger)
  normalized.commandRe = compile(normalized.commandTools, DEFAULTS.commandTools, 'commandTools', logger)
  normalized.verifyRes = patterns.map((pattern) => {
    try {
      return new RegExp(pattern, 'i')
    } catch {
      logger.warn(`verifyPatterns 中的 "${pattern}" 不是合法正则，已忽略`)
      return null
    }
  }).filter(Boolean)
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

export { createState as __createState }
