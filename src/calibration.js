/**
 * v41pro-calibration —— 预测校准账本。
 *
 * Flash 的另一个系统性偏差是**过度自信**：动手前觉得「十分钟能搞定」，收尾时
 * 既没留下当时怎么想的，也无从知道偏差有多大。本模块只做两件事：交付前把
 * 「成功概率 / 预计耗时」写进磁盘，交付后结算；再用 Brier 与耗时 MAE 把直觉
 * 和现实对账。
 *
 * 记录是全局的（跨会话共享），因为校准衡量的是同一个模型长期的可靠性，不是
 * 单次会话的表现。文件：`$DSH_HOME/v41pro/calibration/records.json`。
 *
 * 本模块不注册收尾门禁，也不注入 pre-step 消息 —— 它只在被调用时读写账本。
 */

import fsp from 'node:fs/promises'

import { bool, makeLogger, num, str } from './core/config.js'
import { sessionKey } from './core/state.js'
import { GlobalJson, makeId, v41Dir } from './core/persist.js'
import { truncate } from './core/util.js'

export const name = 'v41pro-calibration'

export const inject = ['tools', 'commands']

export const DEFAULTS = {
  enabled: true,
  language: 'zh',
  /** 全局账本最多保留多少条；超出后丢弃最旧的。 */
  cap: 500,
}

/** `settle` 接受的结算结果。partial 只计数，不计入 Brier。 */
export const OUTCOMES = ['success', 'failure', 'partial']

// ── 纯函数：统计口径 ────────────────────────────────────────────────────────

/**
 * Brier 分数：mean((probability - actual)^2)。
 * 只统计已结算且结果为 success(1) / failure(0) 的记录；partial 与未结算排除。
 * 样本为空时返回 null（没有数据 ≠ 完美校准）。
 * @param {any[]} records
 * @returns {number | null}
 */
export function brierScore(records) {
  const scores = []
  for (const record of listOfRecords(records)) {
    const actual = outcomeValue(record?.outcome)
    const probability = probabilityOf(record)
    if (actual === null || probability === null) continue
    scores.push((probability - actual) ** 2)
  }
  return scores.length > 0 ? average(scores) : null
}

/**
 * 耗时平均绝对误差（分钟）：|minutes - actualMinutes|。
 * 只统计同时有预计耗时与实际耗时（且都非负）的记录。
 * @param {any[]} records
 * @returns {number | null}
 */
export function meanAbsError(records) {
  const errors = []
  for (const record of listOfRecords(records)) {
    const predicted = numberOrNull(record?.minutes)
    const actual = numberOrNull(record?.actualMinutes)
    if (predicted === null || predicted < 0 || actual === null || actual < 0) continue
    errors.push(Math.abs(predicted - actual))
  }
  return errors.length > 0 ? average(errors) : null
}

/**
 * 汇总账本。
 * n = 记录总数（含未结算），open = 未结算数，partial = partial 数；
 * brier/overconfidence 只按 success/failure 计算，maeMinutes 只按有 actualMinutes
 * 的记录计算；无样本时对应字段为 null。
 * @param {any[]} records
 * @returns {{ n: number, open: number, brier: number | null, overconfidence: number | null, maeMinutes: number | null, partial: number }}
 */
export function summarize(records) {
  const list = listOfRecords(records)
  const resolved = list.filter(record => outcomeValue(record?.outcome) !== null && probabilityOf(record) !== null)
  let overconfidence = null
  if (resolved.length > 0) {
    const predicted = average(resolved.map(record => probabilityOf(record)))
    const successRate = resolved.filter(record => record.outcome === 'success').length / resolved.length
    overconfidence = predicted - successRate
  }
  return {
    n: list.length,
    open: list.filter(record => !record?.outcome).length,
    brier: brierScore(list),
    overconfidence,
    maeMinutes: meanAbsError(list),
    partial: list.filter(record => record?.outcome === 'partial').length,
  }
}

// ── 插件入口 ────────────────────────────────────────────────────────────────

/**
 * @param {any} ctx
 * @param {Record<string, unknown>} [rawConfig]
 */
export function apply(ctx, rawConfig = {}) {
  const logger = makeLogger(ctx, name)
  const cfg = normalize(rawConfig)
  if (!cfg.enabled) {
    logger.info('enabled=false，预测校准账本已关闭')
    return
  }

  const store = new GlobalJson(cfg.dir, 'records', { version: 1, records: [] })

  /** 读改写全局账本；损坏的 JSON 先备份再重建，错误不抛给宿主。 */
  async function withRecords(mutate) {
    try {
      return await store.update(data => {
        prepare(data)
        return mutate(data)
      })
    } catch (error) {
      if (!(await recoverLedger(store, logger, error))) throw error
      return await store.update(data => {
        prepare(data)
        return mutate(data)
      })
    }
  }

  async function readRecords() {
    try {
      const data = await store.read()
      prepare(data)
      return data.records
    } catch (error) {
      if (!(await recoverLedger(store, logger, error))) throw error
      const data = await store.read()
      prepare(data)
      return data.records
    }
  }

  // ── forecast：交付前记录预测 ──────────────────────────────────────────────
  ctx.effect(() => ctx.tools.register({
    name: 'forecast',
    description: '交付前记录预测：成功概率（必填，0..1）与预计耗时分钟（可选），事后用 settle 结算并统计 Brier、过度自信与耗时误差。可先记预测再动手，不要凭记忆估算。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '这次预测对应的任务，一句话说清。' },
        probability: { type: 'number', description: '你判断能成功的概率，0..1。' },
        minutes: { type: 'number', description: '预计耗时（分钟），可选。' },
        risks: { type: 'array', items: { type: 'string' }, description: '主要风险，可选。' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签，可选。' },
      },
      required: ['task', 'probability'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          open: { type: 'number' },
          text: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    async execute(args, exec) {
      exec?.signal?.throwIfAborted?.()
      try {
        return await recordForecast(args && typeof args === 'object' ? args : {}, exec)
      } catch (error) {
        if (exec?.signal?.aborted) throw error
        logger.warn('记录预测失败：', errorText(error))
        return fail(t(cfg.language, `记录预测失败：${errorText(error)}`, `failed to record the forecast: ${errorText(error)}`))
      }
    },
  }), 'v41pro-calibration.forecast')

  // ── settle：交付后结算 ────────────────────────────────────────────────────
  ctx.effect(() => ctx.tools.register({
    name: 'settle',
    description: '结算一条预测：outcome=success|failure|partial；省略 id 时结算本会话最近一条未结算记录；可附 actual_minutes 与 note。partial 只计数，不计入 Brier。',
    parameters: {
      type: 'object',
      properties: {
        outcome: { type: 'string', enum: OUTCOMES, description: '实际结果。' },
        id: { type: 'string', description: '要结算的预测 id；省略则结算本会话最近一条未结算。' },
        actual_minutes: { type: 'number', description: '实际耗时（分钟），可选。' },
        note: { type: 'string', description: '偏差原因等备注，可选。' },
      },
      required: ['outcome'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          outcome: { type: 'string' },
          settled: { type: 'number' },
          open: { type: 'number' },
          text: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    async execute(args, exec) {
      exec?.signal?.throwIfAborted?.()
      try {
        return await recordSettlement(args && typeof args === 'object' ? args : {}, exec)
      } catch (error) {
        if (exec?.signal?.aborted) throw error
        logger.warn('结算预测失败：', errorText(error))
        return fail(t(cfg.language, `结算预测失败：${errorText(error)}`, `failed to settle the forecast: ${errorText(error)}`))
      }
    },
  }), 'v41pro-calibration.settle')

  // ── 命令：查看账本 ────────────────────────────────────────────────────────
  ctx.effect(() => ctx.commands.register({
    name: 'calibration',
    description: '查看预测校准账本：结算数、未结算数、Brier、过度自信、耗时 MAE 与最近 5 条。',
    input: { hint: 'status' },
    async handler(payload = {}) {
      const signal = payload?.signal
      signal?.throwIfAborted?.()
      try {
        return { kind: 'success', text: renderStatus(await readRecords(), cfg) }
      } catch (error) {
        if (signal?.aborted) throw error
        logger.warn('读取校准账本失败：', errorText(error))
        return { kind: 'error', text: t(cfg.language, `读取校准账本失败：${errorText(error)}`, `failed to read the calibration ledger: ${errorText(error)}`) }
      }
    },
  }), 'v41pro-calibration.command')

  // ── 内部实现 ──────────────────────────────────────────────────────────────

  async function recordForecast(input, exec) {
    const task = typeof input.task === 'string' ? input.task.trim() : ''
    if (!task) return fail(t(cfg.language, 'forecast 需要非空的 task。', 'forecast requires a non-empty task.'))

    const probability = numberOrNull(input.probability)
    if (probability === null || probability < 0 || probability > 1) {
      return fail(t(cfg.language,
        `probability 必须是 0..1 之间的数字，收到 ${show(input.probability)}。`,
        `probability must be a number within 0..1, got ${show(input.probability)}.`))
    }

    let minutes = null
    if (input.minutes !== undefined && input.minutes !== null) {
      minutes = numberOrNull(input.minutes)
      if (minutes === null || minutes < 0) {
        return fail(t(cfg.language,
          `minutes 必须是非负数字，收到 ${show(input.minutes)}。`,
          `minutes must be a non-negative number, got ${show(input.minutes)}.`))
      }
    }

    const record = {
      id: makeId('fc'),
      session: sessionOf(exec?.agent),
      task: cut(task, 300),
      probability,
      minutes,
      risks: stringList(input.risks, 5),
      tags: stringList(input.tags, 8),
      createdAt: Date.now(),
    }

    const open = await withRecords(data => {
      data.records.push(record)
      if (data.records.length > cfg.cap) data.records.splice(0, data.records.length - cfg.cap)
      return data.records.filter(item => item && !item.outcome).length
    })

    const expected = minutes === null ? '' : t(cfg.language, `，预计 ${minutes} 分钟`, `, expected ${minutes} min`)
    return {
      ok: true,
      id: record.id,
      open,
      text: t(cfg.language,
        `已记录预测 ${record.id}：成功概率 ${percent(probability)}${expected}。当前未结算 ${open} 条；交付后用 settle 结算。`,
        `forecast ${record.id} recorded: success probability ${percent(probability)}${expected}. ${open} open record(s); settle it after delivery.`),
    }
  }

  async function recordSettlement(input, exec) {
    const outcome = typeof input.outcome === 'string' ? input.outcome.trim().toLowerCase() : ''
    if (!OUTCOMES.includes(outcome)) {
      return fail(t(cfg.language,
        `outcome 必须是 success|failure|partial，收到 ${show(input.outcome)}。`,
        `outcome must be success|failure|partial, got ${show(input.outcome)}.`))
    }

    let actualMinutes = null
    if (input.actual_minutes !== undefined && input.actual_minutes !== null) {
      actualMinutes = numberOrNull(input.actual_minutes)
      if (actualMinutes === null || actualMinutes < 0) {
        return fail(t(cfg.language,
          `actual_minutes 必须是非负数字，收到 ${show(input.actual_minutes)}。`,
          `actual_minutes must be a non-negative number, got ${show(input.actual_minutes)}.`))
      }
    }

    const id = typeof input.id === 'string' ? input.id.trim() : ''
    const session = sessionOf(exec?.agent)
    if (!id && !session) {
      return fail(t(cfg.language, '无法确定会话，请显式提供要结算的 id。', 'cannot determine the session; pass an explicit id.'))
    }
    const note = typeof input.note === 'string' ? cut(input.note.trim(), 300) : ''

    const result = await withRecords(data => {
      const index = id
        ? data.records.findIndex(item => item && item.id === id)
        : findLastOpen(data.records, session)
      if (index < 0) {
        return {
          error: id
            ? t(cfg.language, `找不到 id=${id} 的预测。`, `no forecast with id=${id}.`)
            : t(cfg.language, '本会话没有未结算的预测；先用 forecast 记录一条。', 'no open forecast in this session; record one with forecast first.'),
        }
      }
      const record = data.records[index]
      if (record.outcome) {
        return {
          error: t(cfg.language,
            `预测 ${record.id} 已经结算过（${record.outcome}），不能重复结算。`,
            `forecast ${record.id} is already settled (${record.outcome}); it cannot be settled twice.`),
        }
      }
      record.outcome = outcome
      record.settledAt = Date.now()
      if (actualMinutes !== null) record.actualMinutes = actualMinutes
      if (note) record.note = note
      return { record, stats: summarize(data.records) }
    })
    if (result.error) return fail(result.error)

    const { record, stats } = result
    const expected = record.minutes === null ? '' : t(cfg.language, `预计 ${record.minutes} 分钟`, `expected ${record.minutes} min`)
    const actual = actualMinutes === null ? '' : t(cfg.language, `，实际 ${actualMinutes} 分钟`, `, actual ${actualMinutes} min`)
    const brier = formatNumber(stats.brier, 3)
    return {
      ok: true,
      id: record.id,
      outcome,
      settled: stats.n - stats.open,
      open: stats.open,
      text: t(cfg.language,
        `已结算 ${record.id}：预测 ${percent(record.probability)}${expected ? `（${expected}）` : ''} → ${outcomeLabel(outcome, 'zh')}${actual}。账本已结算 ${stats.n - stats.open}/${stats.n} 条，未结算 ${stats.open}，Brier ${brier}。`,
        `settled ${record.id}: predicted ${percent(record.probability)}${expected ? ` (${expected})` : ''} → ${outcomeLabel(outcome, 'en')}${actual}. ${stats.n - stats.open}/${stats.n} settled, ${stats.open} open, Brier ${brier}.`),
    }
  }
}

// ── 供测试/工具共用 ────────────────────────────────────────────────────────

/**
 * 从 agent 构造最小的会话状态；测试不依赖 cordis 运行时也能直接调用。
 * @param {any} agent
 */
export function __createState(agent) {
  return { session: sessionKey(agent) || '' }
}

function sessionOf(agent) {
  return __createState(agent).session
}

// ── 账本读写辅助 ────────────────────────────────────────────────────────────

/** 顶层形状校验；不属于可识别的账本时抛 SyntaxError，交给 recoverLedger 处理。 */
function prepare(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new SyntaxError('records.json 顶层不是对象')
  }
  data.version = 1
  if (!Array.isArray(data.records)) data.records = []
}

/**
 * 损坏的 JSON：把原文件改名为 `.corrupt-<时间戳>` 备份后重建，不静默丢数据。
 * 返回是否值得重试一次。
 */
async function recoverLedger(store, logger, error) {
  if (!(error instanceof SyntaxError)) return false
  logger.warn('校准账本无法解析，备份后重建：', errorText(error))
  store.cached = undefined
  try {
    await fsp.rename(store.file, `${store.file}.corrupt-${Date.now()}`)
  } catch (renameError) {
    if (renameError?.code === 'ENOENT') return true
    logger.warn('备份损坏的账本失败，保留原文件：', errorText(renameError))
    return false
  }
  return true
}

function findLastOpen(records, session) {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]
    if (record && !record.outcome && record.session === session) return index
  }
  return -1
}

// ── 文案与格式化 ────────────────────────────────────────────────────────────

function renderStatus(records, cfg) {
  const stats = summarize(records)
  const settled = stats.n - stats.open
  const recent = records.slice(-5).reverse()
  const lines = [
    t(cfg.language, '预测校准账本', 'Calibration ledger'),
    t(cfg.language,
      `已结算 ${settled}（partial ${stats.partial}）/ 未结算 ${stats.open} / 共 ${stats.n} 条`,
      `settled ${settled} (partial ${stats.partial}) / open ${stats.open} / total ${stats.n}`),
    `Brier: ${formatNumber(stats.brier, 3)}`,
    t(cfg.language, `过度自信: ${formatPoints(stats.overconfidence)}`, `overconfidence: ${formatPoints(stats.overconfidence)}`),
    t(cfg.language, `耗时 MAE: ${formatMinutes(stats.maeMinutes, 'zh')}`, `duration MAE: ${formatMinutes(stats.maeMinutes, 'en')}`),
  ]
  if (recent.length === 0) {
    lines.push(t(cfg.language, '最近 5 条：无记录，先用 forecast 记录一条预测。', 'latest 5: none; record a forecast first.'))
    return lines.join('\n')
  }
  lines.push(t(cfg.language, '最近 5 条（新→旧）：', 'latest 5 (new → old):'))
  for (const record of recent) lines.push(`  ${recentLine(record, cfg.language)}`)
  return lines.join('\n')
}

function recentLine(record, language) {
  const outcome = outcomeLabel(record?.outcome, language)
  const actual = numberOrNull(record?.actualMinutes)
  const duration = actual === null ? '' : t(language, ` | 实际 ${actual} 分钟`, ` | actual ${actual} min`)
  return `${percent(record?.probability)} → ${outcome}${duration} | ${truncate(String(record?.task ?? ''), 60)}`
}

function outcomeLabel(outcome, language) {
  const labels = { success: ['成功', 'success'], failure: ['失败', 'failure'], partial: ['部分成功', 'partial'] }
  const label = labels[outcome]
  if (!label) return t(language, '未结算', 'open')
  return language === 'en' ? label[1] : label[0]
}

function percent(value) {
  const number = numberOrNull(value)
  return number === null ? '—' : `${(number * 100).toFixed(0)}%`
}

function formatNumber(value, digits) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—'
}

function formatPoints(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  const points = value * 100
  return `${points >= 0 ? '+' : ''}${points.toFixed(1)}pp`
}

function formatMinutes(value, language) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return language === 'en' ? `${value.toFixed(1)} min` : `${value.toFixed(1)} 分钟`
}

function t(language, zh, en) {
  return language === 'en' ? en : zh
}

function fail(message) {
  return { ok: false, error: message, text: message }
}

// ── 输入归一化 ──────────────────────────────────────────────────────────────

function normalize(raw) {
  const config = raw && typeof raw === 'object' ? raw : {}
  const language = str(config.language, DEFAULTS.language)
  return {
    enabled: bool(config.enabled, DEFAULTS.enabled),
    language: language === 'en' ? 'en' : 'zh',
    cap: num(config.cap, DEFAULTS.cap, { min: 1, max: 100_000 }),
    dir: str(config.dir, '').trim() || v41Dir('calibration'),
  }
}

/** 预测值只接受 0..1；其余记为无效，统计时跳过。 */
function probabilityOf(record) {
  const value = numberOrNull(record?.probability)
  return value !== null && value >= 0 && value <= 1 ? value : null
}

/** 结算结果 → Brier 的实际值；partial 与未结算返回 null。 */
function outcomeValue(outcome) {
  if (outcome === 'success') return 1
  if (outcome === 'failure') return 0
  return null
}

/** 数字或数字字符串 → 有限数；其余返回 null。 */
function numberOrNull(value) {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null
}

function stringList(value, max) {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  const result = []
  for (const item of items) {
    if (typeof item !== 'string') continue
    const text = item.trim()
    if (text) result.push(cut(text, 120))
    if (result.length >= max) break
  }
  return result
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function listOfRecords(records) {
  return Array.isArray(records) ? records : []
}

function cut(text, max) {
  return text.length > max ? text.slice(0, max) : text
}

function show(value) {
  if (value === undefined) return 'undefined'
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}
