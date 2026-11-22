/**
 * v41pro-shrink —— 代码精简审查。
 *
 * 用户规则：写完代码之后必须有一道「还能不能更短」的审查；删、并、保留都要
 * 给理由，未审查不得收尾。插件把这条规则变成可观测的门禁：
 *
 *  1. `tools/post-execute`：把本轮编辑过的**代码文件**记进 `edited`（按扩展名
 *     白名单过滤，非代码文件不算）。
 *  2. `agent/turn-stopping`：还有没审查的代码文件就 `agent.steer()` 一次，
 *     点名文件、要求逐个给出删/并/保留理由；每回合最多催 maxNudges 次。
 *  3. `code_shrink` 工具收结论：每个文件至少一条 finding，`kept` 必须带非空
 *     detail；缺覆盖直接返回结构化错误且**不记录**。成功才落盘并清空待审查。
 *
 * 行数口径：追踪一个文件时读一次磁盘作为「审查前」基线（也就是初始写完后的
 * 大小），审查时再读一次作为「审查后」。中间通过编辑工具完成的精简就是
 * saved。局限：如果模型在同一回合里第二次打开一个老文件，基线会是老文件当时
 * 的大小，而不是本轮开始前的大小；文件读不到时按 0 计。
 */

import fsp from 'node:fs/promises'

import { bool, makeLogger, num, str } from './core/config.js'
import { createAgentStore, sessionKey } from './core/state.js'
import { createNotice } from './core/message.js'
import { sourceNote } from './core/text.js'
import { SessionJson, v41Dir } from './core/persist.js'
import { truncate } from './core/util.js'
import { GateTracker, auditShrinkDecisions, banner } from './core/gate-escalation.js'

export const name = 'v41pro-shrink'

export const inject = ['tools', 'commands']

export const DEFAULTS = {
  enabled: true,
  /** 是否启用收尾门禁。false 时只提供 code_shrink 工具与命令。 */
  gate: true,
  /** 一回合最多催几次做精简审查。 */
  maxNudges: 2,
  language: 'zh',
  /** 一次审查最多覆盖多少个文件。 */
  maxFiles: 20,
  /** 只追踪这些扩展名；其余文件（文档、配置、数据）不算代码编辑。 */
  codeExtensions: [
    '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.kt',
    '.c', '.cc', '.cpp', '.h', '.cs', '.rb', '.php', '.swift', '.sh', '.ps1',
  ],
  /** 存储目录；空表示 `v41Dir('shrink')`。 */
  dir: '',
}

/** 被当作「编辑文件」的工具名。带前缀/后缀的变体（str_replace_editor 等）也算。 */
export const EDIT_TOOLS = [
  'edit', 'write', 'apply_patch', 'multi_edit', 'notebook_edit', 'str_replace',
  'str_replace_editor', 'create_file', 'write_file', 'edit_file', 'apply_diff',
  'patch', 'insert_edit_into_file', 'search_replace',
]

/** finding 的 action 只有这三种。 */
const FINDING_ACTIONS = ['removed', 'merged', 'kept']

/** 参数里可能携带文件路径的键。 */
const PATH_KEYS = ['path', 'file_path', 'filePath', 'file', 'files']

/** 文本行数：空串 0 行；末尾换行不额外算一行（与 wc -l 一致）。 */
export function countLines(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  const lines = text.split(/\r\n|\r|\n/)
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.length
}

/** 扩展名兼容不写点的写法；大小写不敏感。 */
export function isCodeFile(filePath, extensions = DEFAULTS.codeExtensions) {
  if (typeof filePath !== 'string' || !filePath.trim()) return false
  const target = filePath.trim().toLowerCase()
  const list = Array.isArray(extensions) ? extensions : []
  for (const raw of list) {
    if (typeof raw !== 'string' || !raw.trim()) continue
    const ext = raw.trim().toLowerCase()
    if (target.endsWith(ext.startsWith('.') ? ext : `.${ext}`)) return true
  }
  return false
}

/** 汇总 findings：总数、涉及文件数、三种动作各多少。 */
export function summarizeFindings(findings) {
  const summary = { total: 0, files: 0, removed: 0, merged: 0, kept: 0, unknown: 0 }
  const files = new Set()
  if (!Array.isArray(findings)) return summary
  for (const finding of findings) {
    if (!finding || typeof finding !== 'object') continue
    summary.total += 1
    const file = typeof finding.file === 'string' ? finding.file.trim() : ''
    if (file) files.add(file)
    if (finding.action === 'removed') summary.removed += 1
    else if (finding.action === 'merged') summary.merged += 1
    else if (finding.action === 'kept') summary.kept += 1
    else summary.unknown += 1
  }
  summary.files = files.size
  return summary
}

function createState() {
  return {
    /** @type {Map<string, { firstAt: number, lastAt: number, count: number }>} */
    edited: new Map(),
    /** 审查前基线行数：追踪时读一次磁盘。 @type {Map<string, number|null>} */
    baselines: new Map(),
    reviewedAt: 0,
    /** @type {Array<{ file: string, category: string, action: string, detail: string }>} */
    reviewed: [],
    /** @type {Record<string, number> | null} */
    lastStats: null,
    nudges: 0,
    gateTracker: null,
    gateReported: false,
    lastPending: null,
    turn: 0,
    /** @type {Promise<void>} */
    ready: Promise.resolve(),
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
    logger.info('enabled=false，代码精简审查已关闭')
    return
  }

  const states = createAgentStore(() => createState())
  const store = new SessionJson(cfg.dir, 'shrink')

  // ── 回合边界：换回合就清空待审查集合与催促计数 ──────────────────────────
  ctx.on('agent/pre-step', async (payload, next) => {
    try {
      const state = states.get(payload.agent)
      if (payload.turn !== state.turn) {
        state.turn = payload.turn
        state.nudges = 0
        state.gateTracker = null
        state.gateReported = false
        state.lastPending = null
        state.edited.clear()
        state.baselines.clear()
      }
    } catch (error) {
      logger.warn('精简审查回合边界处理失败：', message(error))
    }
    return next()
  })

  // ── 追踪：本轮编辑过的代码文件 ──────────────────────────────────────────
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    try {
      if (exec?.agent) {
        const state = states.get(exec.agent)
        await state.ready
        await track(state, exec, result, cfg)
      }
    } catch (error) {
      logger.warn('精简审查追踪失败：', message(error))
    }
    return downstream
  })

  // ── 收尾门禁 ────────────────────────────────────────────────────────────
  ctx.on('agent/turn-stopping', ({ agent }) => {
    if (!cfg.gate) return
    try {
      nudge(agent, states.get(agent), cfg, logger)
    } catch (error) {
      logger.warn('精简审查门禁失败：', message(error))
    }
  })

  // ── 会话建立：从磁盘恢复上次审查记录 ────────────────────────────────────
  ctx.on('agent/created', ({ agent }) => {
    try {
      hydrate(states.get(agent), agent, store, logger)
    } catch (error) {
      logger.warn('读取精简审查记录失败：', message(error))
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    states.delete(agent)
  })

  // ── code_shrink 工具 ────────────────────────────────────────────────────
  ctx.effect(() => {
    const disposer = ctx.tools.register({
      name: 'code_shrink',
      description: [
        '逐个文件检查刚写完的代码是否还能更短；删 / 并 / 保留都必须给理由。',
        '本轮每个被编辑过的代码文件至少一条 finding；action="kept" 必须带非空 detail（保留理由）。',
        '文件互相重复就 merged 并写明并到哪；删掉无用代码就 removed 并写明删了什么。',
        '行数由磁盘实测：saved = 审查前基线行数 - 审查后行数。',
        '缺文件覆盖或 kept 无理由时会直接拒绝，不会记为已审查。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            items: { type: 'string' },
            description: '要审查的文件；省略时取本轮编辑过的代码文件（最多 maxFiles 个）。',
          },
          findings: {
            type: 'array',
            description: '每个文件至少一条结论。',
            items: {
              type: 'object',
              properties: {
                file: { type: 'string', description: '被审查的文件路径。' },
                category: { type: 'string', description: '问题类别，例如 dead / dup / verbose。' },
                action: { type: 'string', enum: FINDING_ACTIONS, description: 'removed / merged / kept。' },
                detail: { type: 'string', description: '删了什么、并到哪；action=kept 时是必填的保留理由。' },
              },
              required: ['file', 'action'],
              additionalProperties: false,
            },
          },
          reason: { type: 'string', description: '整体说明；allow_keep_all=true 时必填。' },
          allow_keep_all: {
            type: 'boolean',
            description: '本轮所有文件都保持原样时，用 reason 自动生成 kept 结论（仍会记录理由）。',
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            code: { type: 'string' },
            error: { type: 'string' },
            files: { type: 'array', items: { type: 'string' } },
            linesBefore: { type: 'integer' },
            linesAfter: { type: 'integer' },
            saved: { type: 'integer' },
            findings: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  file: { type: 'string' },
                  category: { type: 'string' },
                  action: { type: 'string', enum: FINDING_ACTIONS },
                  detail: { type: 'string' },
                },
                required: ['file', 'action'],
                additionalProperties: false,
              },
            },
            text: { type: 'string' },
          },
          required: ['ok', 'files', 'linesBefore', 'linesAfter', 'saved', 'findings', 'text'],
          additionalProperties: false,
        },
        render(_args, value) {
          return [{ type: 'text', text: value.text }]
        },
      },
      async execute(args, exec) {
        const input = args && typeof args === 'object' ? args : {}
        return review(input, exec)
      },
    })
    return () => {
      try {
        disposer?.()
      } catch {
        /* ignore */
      }
    }
  }, `${name} tool`)

  // ── /shrink 命令 ────────────────────────────────────────────────────────
  ctx.effect(() => {
    const disposer = ctx.commands.register({
      name: 'shrink',
      description: '查看代码精简审查状态：待审查文件 + 上次审查统计',
      input: { hint: 'status' },
      async handler({ agent, rawInput }) {
        try {
          const state = agent ? states.get(agent) : createState()
          await state.ready
          const input = str(rawInput, '').trim()
          const text = statusText(state, cfg)
          return {
            kind: 'success',
            text: input && input !== 'status' ? `shrink 目前只支持 status。\n\n${text}` : text,
          }
        } catch (error) {
          return { kind: 'error', text: `读取精简审查状态失败：${message(error)}` }
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
  }, `${name}.command`)

  // ── 内部：审查 ──────────────────────────────────────────────────────────

  async function review(input, exec) {
    const agent = exec?.agent
    const state = agent ? states.get(agent) : createState()
    await state.ready

    if (input.files !== undefined && !Array.isArray(input.files)) {
      return failure('bad-files', 'files 必须是字符串数组；省略 files 时自动取本轮编辑过的代码文件。')
    }
    const requested = Array.isArray(input.files)
      ? unique(input.files.filter(item => typeof item === 'string' && item.trim()).map(canonicalPath))
      : []
    if (Array.isArray(input.files) && requested.length === 0) {
      return failure('bad-files', 'files 不能是空数组；不想指定就省略它。')
    }
    const targets = input.files !== undefined
      ? requested.slice(0, cfg.maxFiles)
      : unique([...state.edited.keys()]).slice(0, cfg.maxFiles)
    if (targets.length === 0) {
      return failure('no-files', '没有待审查的代码文件：本轮没有代码编辑记录，请显式传入 files。')
    }

    let findings
    const rawFindings = Array.isArray(input.findings) ? input.findings : []
    if (rawFindings.length === 0) {
      if (bool(input.allow_keep_all, false)) {
        const reason = str(input.reason, '').trim()
        if (!reason) {
          return failure('keep-all-reason', 'allow_keep_all 需要 reason：说明为什么这些文件都保持原样。', targets)
        }
        findings = targets.map(file => ({ file, category: 'keep-all', action: 'kept', detail: reason }))
      } else {
        return failure(
          'missing-findings',
          `每个被审查的文件都必须有 finding（${targets.length} 个文件）：请逐个给出 removed/merged/kept 结论，保留也要写理由。`,
          targets,
        )
      }
    } else {
      const parsed = []
      for (let index = 0; index < rawFindings.length; index += 1) {
        const problem = validateFinding(rawFindings[index], index)
        if (problem) return failure('invalid-finding', problem, targets)
        parsed.push(normalizeFinding(rawFindings[index]))
      }
      findings = parsed
    }

    const covered = new Set(findings.map(finding => finding.file))
    const missing = targets.filter(file => !covered.has(file))
    if (missing.length > 0) {
      const list = missing.slice(0, 5).map(file => `\`${truncate(file, 80)}\``).join('、')
      return failure(
        'missing-coverage',
        `以下文件没有 finding：${list}${missing.length > 5 ? ` 等 ${missing.length} 个` : ''}。`,
        targets,
      )
    }

    let linesBefore = 0
    let linesAfter = 0
    for (const file of targets) {
      const after = (await readLineCount(file)) ?? 0
      const baseline = state.baselines.get(file)
      linesBefore += typeof baseline === 'number' ? baseline : after
      linesAfter += after
    }

    const summary = summarizeFindings(findings)
    const stats = {
      files: targets.length,
      linesBefore,
      linesAfter,
      saved: linesBefore - linesAfter,
      removed: summary.removed,
      merged: summary.merged,
      kept: summary.kept,
    }
    const reviewedAt = Date.now()

    state.reviewedAt = reviewedAt
    state.reviewed = findings
    state.lastStats = stats
    state.edited.clear()
    state.baselines.clear()

    const audit = auditShrinkDecisions(findings.map(finding => ({ file: finding.file, action: finding.action, reason: finding.detail })))
    const weak = audit.ok ? '' : `\n\n⚠ 审查理由偏弱：${[...new Set([...audit.perfunctory, ...audit.duplicates])].slice(0, 5).join('、')}；请补充具体依据（删除什么 / 并到哪里 / 为什么必须保留）。`

    const key = agent ? sessionKey(agent) : ''
    if (key) {
      try {
        await store.save(key, {
          version: 1,
          session: key,
          reviewedAt,
          findings,
          lastStats: stats,
        })
      } catch (error) {
        logger.warn('保存精简审查记录失败：', message(error))
      }
    }

    return {
      ok: true,
      files: targets,
      linesBefore,
      linesAfter,
      saved: stats.saved,
      findings,
      text: `${successText(findings, stats)}${weak}`,
    }
  }
}

// ── 追踪与门禁 ─────────────────────────────────────────────────────────────

/** 工具名是否属于编辑类；带常见前后缀的变体也算。 */
function isEditTool(toolName) {
  const tool = String(toolName ?? '').toLowerCase()
  if (!tool) return false
  return EDIT_TOOLS.some(candidate =>
    tool === candidate || tool.startsWith(`${candidate}_`) || tool.endsWith(`_${candidate}`))
}

/** 从工具参数里取出路径；支持 file / files 数组。 */
function extractFilePaths(args) {
  const paths = []
  if (!args || typeof args !== 'object') return paths
  for (const key of PATH_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) {
      paths.push(value.trim())
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && item.trim()) {
          paths.push(item.trim())
          continue
        }
        if (item && typeof item === 'object') {
          for (const inner of ['path', 'file_path', 'filePath', 'file']) {
            if (typeof item[inner] === 'string' && item[inner].trim()) {
              paths.push(item[inner].trim())
              break
            }
          }
        }
      }
    }
  }
  return paths
}

async function track(state, exec, result, cfg) {
  // 失败的编辑没有真正改到文件，不算「写完的代码」。
  if (result?.isError === true) return
  if (!isEditTool(exec.name)) return
  const candidates = extractFilePaths(exec.arguments ?? exec.args)
  const now = Date.now()
  for (const candidate of candidates) {
    const file = canonicalPath(candidate)
    if (!isCodeFile(file, cfg.codeExtensions)) continue
    const entry = state.edited.get(file)
    if (entry) {
      entry.lastAt = now
      entry.count += 1
      continue
    }
    state.edited.set(file, { firstAt: now, lastAt: now, count: 1 })
    // 基线只在该文件第一次被追踪时读一次：它就是「精简前」的大小。
    state.baselines.set(file, await readLineCount(file))
  }
}

function nudge(agent, state, cfg, logger) {
  if (state.edited.size === 0) return
  if (state.gateReported) return
  const files = [...state.edited.keys()]
  const tracker = state.gateTracker ?? (state.gateTracker = new GateTracker({ maxSteers: Math.max(1, cfg.maxNudges) }))
  const progress = state.lastPending != null && files.length < state.lastPending
  state.lastPending = files.length
  const step = tracker.next('精简审查', { pending: files, progress })
  if (step.action === 'pass') return
  if (step.action === 'report-unverified') {
    state.gateReported = true
    logger.warn(`本轮已提醒 ${cfg.maxNudges} 次，仍有 ${files.length} 个文件未审查；要求在回答末尾标注`)
    const zh = cfg.language !== 'en'
    agent.steer(createNotice({
      kind: name,
      summary: `${files.length} 个代码文件仍未审查`,
      text: `${banner('精简审查', files)}\n\n${zh ? '这是最后一次提醒：把上面那行「⚠ 未验证」原样放在最终回答的最后一行，然后结束，不要继续循环。' : 'This is the last reminder: copy that line verbatim as the final line of your answer, then stop. Do not loop.'}\n\n${sourceNote(cfg.language)}`,
    }))
    return
  }
  state.nudges += 1
  logger.info(`收尾拦截：${files.length} 个代码文件未做精简审查`)
  const strong = step.action === 'steer-strong'
  const lead = strong
    ? (cfg.language === 'en' ? 'No progress since the last reminder. You must call `code_shrink` with one finding per file; prose alone does not count.\n\n' : '上次提醒后仍无进展：必须调用 `code_shrink` 逐文件提交 finding，只用文字回答不算完成。\n\n')
    : ''
  agent.steer(createNotice({
    kind: name,
    summary: `${files.length} 个代码文件待精简审查`,
    text: `${lead}${nudgeText(files, cfg)}`,
  }))
}

function nudgeText(files, cfg) {
  const shown = files.slice(0, 5).map(file => `\`${truncate(file, 80)}\``).join('、')
  const more = files.length > 5 ? `（另有 ${files.length - 5} 个）` : ''
  if (cfg.language === 'en') {
    return [
      `This turn has ${files.length} code file(s) without a shrink review: ${listed(files)}.`,
      'Before finishing, check each one: can it be deleted? can two pieces be merged? If you keep it, give the reason.',
      'Submit one finding per file with `code_shrink` (removed/merged/kept; kept needs a non-empty detail).',
      '',
      sourceNote('en'),
    ].join('\n')
  }
  return [
    `本轮还有 ${files.length} 个代码文件没做精简审查：${shown}${more}。`,
    '收尾前逐个过一遍：哪些代码可以删？哪些可以合并？必须保留的，也要说出保留理由。',
    '用 `code_shrink` 为每个文件提交结论（removed / merged / kept）；kept 的 detail 必须写清为什么不能再短。',
    '',
    sourceNote('zh'),
  ].join('\n')
}

function statusText(state, cfg) {
  const lines = ['## 代码精简审查']
  const pending = [...state.edited.entries()]
  if (pending.length === 0) {
    lines.push('', '本轮没有待审查的代码文件。')
  } else {
    lines.push('', `本轮待审查：${pending.length} 个文件`)
    for (const [file, entry] of pending.slice(0, cfg.maxFiles)) {
      const baseline = state.baselines.get(file)
      const size = typeof baseline === 'number' ? `（审查前 ${baseline} 行）` : ''
      lines.push(`- \`${truncate(file, 100)}\` ×${entry.count}${size}`)
    }
    if (pending.length > cfg.maxFiles) lines.push(`- …还有 ${pending.length - cfg.maxFiles} 个`)
    lines.push('', '用 `code_shrink` 逐个给出删 / 并 / 保留结论（保留也要理由）。')
  }

  if (state.reviewedAt > 0) {
    const summary = summarizeFindings(state.reviewed)
    const stats = state.lastStats ?? {
      files: summary.files,
      linesBefore: 0,
      linesAfter: 0,
      saved: 0,
      removed: summary.removed,
      merged: summary.merged,
      kept: summary.kept,
    }
    lines.push('', `上次审查：${new Date(state.reviewedAt).toLocaleString()}`)
    lines.push(`- ${stats.files} 个文件，${stats.linesBefore} → ${stats.linesAfter} 行（省 ${stats.saved} 行）`)
    lines.push(`- removed ${stats.removed} / merged ${stats.merged} / kept ${stats.kept}`)
  } else {
    lines.push('', '上次审查：无记录。')
  }
  return lines.join('\n')
}

function successText(findings, stats) {
  const head = stats.saved > 0
    ? `✅ 精简审查已记录：${stats.files} 个文件，${stats.linesBefore} → ${stats.linesAfter} 行（省 ${stats.saved} 行）。`
    : stats.saved < 0
      ? `✅ 精简审查已记录：${stats.files} 个文件，${stats.linesBefore} → ${stats.linesAfter} 行（多了 ${-stats.saved} 行）。`
      : `✅ 精简审查已记录：${stats.files} 个文件，${stats.linesBefore} → ${stats.linesAfter} 行（行数未变）。`
  const lines = [head]
  for (const finding of findings.slice(0, 10)) {
    const detail = finding.detail ? ` — ${truncate(finding.detail, 100)}` : ''
    lines.push(`- \`${truncate(finding.file, 100)}\`：${finding.action}${detail}`)
  }
  if (findings.length > 10) lines.push(`- …还有 ${findings.length - 10} 条 finding（已全部记录）`)
  return lines.join('\n')
}

// ── findings 校验 ──────────────────────────────────────────────────────────

/** 返回错误文案；合法时返回空串。 */
function validateFinding(item, index) {
  const label = `第 ${index + 1} 条 finding`
  if (!item || typeof item !== 'object') return `${label}不是对象。`
  const file = canonicalPath(item.file)
  if (!file) return `${label}缺少 file。`
  if (!FINDING_ACTIONS.includes(item.action)) {
    return `${label}的 action 必须是 removed / merged / kept，收到 ${JSON.stringify(item.action)}。`
  }
  if (item.action === 'kept' && !str(item.detail, '').trim()) {
    return `${label}（\`${truncate(file, 60)}\`）action=kept 但没有 detail：保留也要给出理由。`
  }
  return ''
}

function normalizeFinding(item) {
  return {
    file: canonicalPath(item.file),
    category: str(item.category, '').trim() || 'general',
    action: item.action,
    detail: str(item.detail, '').trim(),
  }
}

/** 宽容地从磁盘恢复：认不出的条目直接丢掉，不让旧数据把插件弄挂。 */
function sanitizeFindings(value) {
  if (!Array.isArray(value)) return []
  const findings = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const file = canonicalPath(item.file)
    if (!file || !FINDING_ACTIONS.includes(item.action)) continue
    findings.push({
      file,
      category: str(item.category, ''),
      action: item.action,
      detail: str(item.detail, ''),
    })
  }
  return findings
}

// ── 落盘 ───────────────────────────────────────────────────────────────────

function hydrate(state, agent, store, logger) {
  const key = sessionKey(agent)
  if (!key) return
  state.ready = store.load(key, null)
    .then(data => restoreState(state, data))
    .catch(error => {
      logger.warn('读取精简审查记录失败，按空状态继续：', message(error))
    })
}

function restoreState(state, data) {
  if (!data || typeof data !== 'object') return
  state.reviewedAt = num(data.reviewedAt, 0, { min: 0 }) || 0
  state.reviewed = sanitizeFindings(data.findings)
  state.lastStats = restoreStats(data.lastStats)
}

function restoreStats(value) {
  if (!value || typeof value !== 'object') return null
  return {
    files: num(value.files, 0, { min: 0 }),
    linesBefore: num(value.linesBefore, 0, { min: 0 }),
    linesAfter: num(value.linesAfter, 0, { min: 0 }),
    saved: num(value.saved, 0),
    removed: num(value.removed, 0, { min: 0 }),
    merged: num(value.merged, 0, { min: 0 }),
    kept: num(value.kept, 0, { min: 0 }),
  }
}

// ── 小工具 ─────────────────────────────────────────────────────────────────

/** 统一成 `/` 分隔、去掉 `./` 前缀，便于比较同一文件的不同写法。 */
function canonicalPath(filePath) {
  return String(filePath ?? '').trim().replace(/\\/g, '/').replace(/^\.\/+/, '')
}

async function readLineCount(file) {
  try {
    return countLines(await fsp.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

function unique(list) {
  return [...new Set(list)]
}

function listed(files) {
  return files.slice(0, 5).map(file => `\`${truncate(file, 80)}\``).join(', ')
}

function failure(code, error, targets = []) {
  return {
    ok: false,
    code,
    error,
    files: targets,
    linesBefore: 0,
    linesAfter: 0,
    saved: 0,
    findings: [],
    text: `❌ 精简审查未记录：${error}`,
  }
}

function message(error) {
  return error instanceof Error ? error.message : String(error)
}

function normalize(raw, logger) {
  const config = raw && typeof raw === 'object' ? raw : {}
  if (config.codeExtensions !== undefined && !Array.isArray(config.codeExtensions)) {
    logger.warn('codeExtensions 不是数组，已使用默认扩展名白名单')
  }
  return {
    enabled: bool(config.enabled, DEFAULTS.enabled),
    gate: bool(config.gate, DEFAULTS.gate),
    maxNudges: num(config.maxNudges, DEFAULTS.maxNudges, { min: 0, max: 10 }),
    language: str(config.language, DEFAULTS.language) === 'en' ? 'en' : 'zh',
    maxFiles: num(config.maxFiles, DEFAULTS.maxFiles, { min: 1, max: 100 }),
    codeExtensions: normalizeExtensions(config.codeExtensions),
    dir: str(config.dir, DEFAULTS.dir).trim() || v41Dir('shrink'),
  }
}

function normalizeExtensions(value) {
  const list = Array.isArray(value) ? value : DEFAULTS.codeExtensions
  const extensions = []
  for (const item of list) {
    if (typeof item !== 'string' || !item.trim()) continue
    const ext = item.trim().toLowerCase()
    const normalized = ext.startsWith('.') ? ext : `.${ext}`
    if (!extensions.includes(normalized)) extensions.push(normalized)
  }
  return extensions.length > 0 ? extensions : [...DEFAULTS.codeExtensions]
}
