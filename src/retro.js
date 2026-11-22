/**
 * v41pro-retro —— 复盘与规则库。
 *
 * 解决的问题：同一种错会犯第二次。模型每次会话都从零开始，上一轮的教训
 * 留在聊天记录里，压缩一次就永久丢了。这里把「发生了什么 / 为什么 / 下次
 * 怎么做」写进磁盘，并把可复用的教训升级成规则；新回合开始时只要用户的话
 * 命中了规则里的关键词，就注入一条极短的提醒。
 *
 * 两层存储：
 *  - 复盘是会话私有的：`$dir/<session>.retro.json`，只在本会话的命令里回放。
 *  - 规则是全局的：`$dir/rules.json`，跨会话生效，按规范化文本去重。
 *
 * 注入刻意做成 snapshot，且每回合最多一次、最多 `maxInjected` 条：规则是
 * 提醒，不是新需求；反复注入只会把上下文挤满。
 *
 * 默认目录：`$DSH_HOME/v41pro/retro`；测试用临时目录覆盖 `dir`。
 */

import { bool, makeLogger, num, str } from './core/config.js'
import { createAgentStore, sessionKey } from './core/state.js'
import { createSnapshot } from './core/message.js'
import { blocksToText } from './core/util.js'
import { sourceNote } from './core/text.js'
import { SessionJson, GlobalJson, v41Dir, makeId } from './core/persist.js'

export const name = 'v41pro-retro'

export const inject = ['tools', 'commands']

export const DEFAULTS = {
  enabled: true,
  language: 'zh',
  maxRules: 200,
  injectRules: true,
  maxInjected: 3,
}

/** 会话复盘条数上限（契约固定 200）。 */
const MAX_ITEMS = 200
/** rules 工具一次最多返回多少条。 */
const MAX_LISTED = 20
/** 单条规则在注入快照里的最大展示字数。 */
const RULE_CHARS = 120
/** 规则原文入库上限，防止一次粘贴把规则库撑爆。 */
const RULE_SOURCE_CHARS = 300
/** 单条复文字段上限。 */
const FIELD_CHARS = 1000
/** 用于匹配的用户文本上限，避免超长粘贴把打分拖慢。 */
const MATCH_SOURCE_CHARS = 8000
/** 命中阈值：一个中文 bigram = 1，一个长英文词 = 2，一个 tag = 3。 */
const HIT_SCORE = 2

/** 英文/数字按词切分时的虚词表；它们不提供可区分的信息。 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'not', 'but', 'you', 'can', 'has', 'have',
  'with', 'this', 'that', 'from', 'into', 'its', 'our', 'out', 'use', 'via', 'then',
  'than', 'when', 'what', 'will', 'your', 'all', 'any', 'one', 'two', 'new', 'get',
  'set', 'may', 'might', 'must', 'should', 'would', 'could', 'does', 'done', 'also',
  'just', 'only', 'very', 'more', 'most', 'some', 'such', 'each', 'about', 'there',
])

/** 中文虚词 bigram；规则与用户文本两边都过滤，避免「这个 / 需要」造成假命中。 */
const CJK_STOPWORDS = new Set([
  '这个', '那个', '我们', '你们', '他们', '可以', '需要', '应该', '如果', '然后',
  '已经', '一下', '时候', '以及', '还是', '就是', '但是', '而且', '因为', '所以',
  '没有', '不是', '一个', '什么', '怎么', '现在', '这里', '那里',
])

const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g
const WORD_RUN = /[a-z0-9_]+/g

/** 会话文件的空值。每次调用都新造，避免 fallback 对象被后续写入污染。 */
const emptySession = () => ({ version: 1, items: [] })

/**
 * 规则去重用的规范化文本：折叠空白、去首尾、去句末标点、统一小写。
 * @param {unknown} text
 * @returns {string}
 */
export function normalizeRuleText(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/[。．.!！?？;；:：,，]+$/u, '')
    .trim()
}

/** 把文本切成用于匹配的 token：中文取 2 字 bigram，英文/数字按词。 */
function tokensOf(text) {
  const value = normalizeRuleText(text)
  /** @type {Set<string>} */
  const tokens = new Set()
  if (!value) return tokens
  for (const run of value.match(CJK_RUN) ?? []) {
    if (run.length === 1) continue
    for (let index = 0; index + 1 < run.length; index += 1) {
      const bigram = run.slice(index, index + 2)
      if (!CJK_STOPWORDS.has(bigram)) tokens.add(bigram)
    }
  }
  for (const word of value.match(WORD_RUN) ?? []) {
    if (word.length >= 2 && !STOPWORDS.has(word)) tokens.add(word)
  }
  return tokens
}

/** 单条规则的得分明细；纯函数，方便测试与调参。 */
function scoreRule(rule, textTokens) {
  let score = 0
  /** @type {string[]} */
  const matched = []
  const seen = new Set()
  const add = (token, weight) => {
    score += weight
    if (!seen.has(token)) {
      seen.add(token)
      matched.push(token)
    }
  }
  for (const token of tokensOf(rule.text)) {
    if (!textTokens.has(token)) continue
    // 英文/数字长词比中文 bigram 更能说明主题，给更高权重。
    add(token, token.length >= 3 && /[a-z0-9]/.test(token) ? 2 : 1)
  }
  const tags = Array.isArray(rule.tags) ? rule.tags : []
  for (const tag of tags) {
    for (const token of tokensOf(tag)) {
      if (textTokens.has(token)) add(token, 3)
    }
  }
  return { score, matched }
}

/**
 * 按关键词从规则库挑出最相关的规则（供 pre-step 与测试使用）。
 *
 * 打分：中文 2 字 bigram、英文/数字词重叠各计分，规则 tags 命中加权；
 * 只返回分数达到阈值的规则，按分数 → hits → updatedAt 降序，最多 `limit` 条。
 *
 * @param {Array<{ id?: string, text: string, tags?: string[], hits?: number, updatedAt?: number }>} rules
 * @param {string} text 用户输入原文
 * @param {number} [limit]
 * @returns {Array<Record<string, any> & { score: number, matched: string[] }>}
 */
export function matchRules(rules, text, limit = 3) {
  const textTokens = tokensOf(text)
  const max = Number.isInteger(limit) && limit > 0 ? limit : DEFAULTS.maxInjected
  if (textTokens.size === 0) return []
  /** @type {Array<Record<string, any> & { score: number, matched: string[] }>} */
  const scored = []
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (!rule || typeof rule !== 'object' || typeof rule.text !== 'string' || !rule.text.trim()) continue
    const result = scoreRule(rule, textTokens)
    if (result.score < HIT_SCORE) continue
    scored.push({ ...rule, score: result.score, matched: result.matched })
  }
  scored.sort((a, b) => b.score - a.score
    || (Number(b.hits) || 0) - (Number(a.hits) || 0)
    || (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
  return scored.slice(0, max)
}

/**
 * @param {any} ctx
 * @param {Record<string, unknown>} [rawConfig]
 */
export function apply(ctx, rawConfig = {}) {
  const logger = makeLogger(ctx, name)
  const cfg = normalize(rawConfig)
  if (!cfg.enabled) {
    logger.info('enabled=false，复盘规则库已关闭')
    return
  }

  const states = createAgentStore(agent => createState(sessionKey(agent)))
  const sessions = new SessionJson(cfg.dir, 'retro')
  const rules = new GlobalJson(cfg.dir, 'rules', { version: 1, rules: [] })

  /** 会话数据懒加载：agent/created 里启动，工具/事件里 await；失败按空记录继续。 */
  function ensureLoaded(state) {
    if (!state.ready) {
      state.ready = state.key
        ? sessions.load(state.key, emptySession())
            .then(data => {
              state.items = sanitizeItems(data?.items)
            })
            .catch(error => {
              logger.warn('读取复盘失败，按空记录继续：', describe(error))
              state.items = []
            })
        : Promise.resolve()
    }
    return state.ready
  }

  // ── 会话建立 / 销毁 ────────────────────────────────────────────────────
  ctx.on('agent/created', ({ agent } = {}) => {
    if (!agent) return
    ensureLoaded(states.get(agent))
  })

  ctx.on('agent/disposed', ({ agent } = {}) => {
    if (agent) states.delete(agent)
  })

  // ── pre-step：用户文本命中规则才注入一条快照，每回合最多一次 ─────────────
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (!decision || decision.kind !== 'enter' || !payload?.agent) return decision
    let snapshot
    try {
      if (cfg.injectRules) {
        const state = states.get(payload.agent)
        await ensureLoaded(state)
        if (state.injectedTurn !== payload.turn) {
          const text = userTextOf(payload.messages)
          if (text) {
            const matched = matchRules(readRules(await rules.read()), text, cfg.maxInjected)
            if (matched.length > 0) {
              state.injectedTurn = payload.turn
              snapshot = buildSnapshot(matched, cfg.language)
              // 命中计数是副作用：异步累加，失败只记日志，不打断本步请求。
              void bumpHits(matched).catch(error => logger.warn('累加规则命中次数失败：', describe(error)))
            }
          }
        }
      }
    } catch (error) {
      logger.warn('复盘规则注入失败：', describe(error))
    }
    if (!snapshot) return decision
    const messages = Array.isArray(decision.messages) ? decision.messages : []
    // 放在最前面：提醒先于本轮用户消息被读到。
    return { ...decision, messages: [snapshot, ...messages] }
  })

  function bumpHits(matched) {
    const ids = new Set(matched.map(rule => rule.id).filter(id => typeof id === 'string' && id))
    if (ids.size === 0) return Promise.resolve()
    return rules.update(data => {
      if (!Array.isArray(data.rules)) data.rules = []
      const now = Date.now()
      for (const rule of data.rules) {
        if (rule && typeof rule === 'object' && ids.has(rule.id)) {
          rule.hits = (Number(rule.hits) || 0) + 1
          rule.updatedAt = now
        }
      }
    })
  }

  // ── 工具 retro：记录复盘，可选沉淀规则 ──────────────────────────────────
  ctx.effect(() => {
    const disposer = ctx.tools.register({
      name: 'retro',
      description: [
        '记录一次复盘：summary（发生了什么，只写事实）、root_cause（可验证的根因）、',
        'lesson（下次具体怎么做）三个必填；可选 rule 把可复用教训沉淀成全局规则，',
        '后续任务命中关键词时自动提醒。规则按规范化文本去重，重复写入只累加 hits。',
      ].join(''),
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: '发生了什么（事实，不写猜测）。' },
          root_cause: { type: 'string', description: '为什么会这样（可验证的根因）。' },
          lesson: { type: 'string', description: '下次具体怎么做（可执行）。' },
          tags: { type: 'array', items: { type: 'string' }, description: '便于命中的标签，如 pnpm、测试、Windows。' },
          rule: { type: 'string', description: '可选：一句可复用的全局规则。' },
        },
        required: ['summary', 'root_cause', 'lesson'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            id: { type: 'string' },
            ruleId: { type: 'string' },
            deduped: { type: 'boolean' },
            text: { type: 'string' },
          },
          required: ['ok', 'text'],
        },
        render(_args, value) {
          return [{ type: 'text', text: value.text }]
        },
      },
      async execute(args, exec) {
        const input = args && typeof args === 'object' ? args : {}
        const summary = requiredText(input.summary, 'summary')
        const rootCause = requiredText(input.root_cause, 'root_cause')
        const lesson = requiredText(input.lesson, 'lesson')
        const tags = tagList(input.tags)
        const ruleText = ruleTextOf(input.rule)
        const agent = exec?.agent
        if (!agent) throw new Error('retro 需要在会话内调用（缺少 agent）。')

        const state = states.get(agent)
        await ensureLoaded(state)

        const item = { id: makeId('retro'), at: Date.now(), summary, rootCause, lesson, tags }
        let saved
        if (ruleText) {
          saved = await writeRule(ruleText, tags)
          item.ruleId = saved.rule.id
        }

        state.items.push(item)
        if (state.items.length > MAX_ITEMS) state.items.splice(0, state.items.length - MAX_ITEMS)
        await saveSession(state)

        const lines = [`已记录复盘 ${item.id}。`, `根因：${clip(rootCause, 120)}`, `教训：${clip(lesson, 120)}`]
        if (saved) {
          lines.push(saved.deduped
            ? `规则：已合并到 ${saved.rule.id}（现命中 ${saved.rule.hits} 次）。`
            : `规则：已新增 ${saved.rule.id}。`)
        } else {
          lines.push('未沉淀全局规则；同类问题再犯时用 rule 参数传一句话即可。')
        }
        return {
          ok: true,
          id: item.id,
          ...(saved ? { ruleId: saved.rule.id } : {}),
          deduped: saved ? saved.deduped : false,
          text: lines.join('\n'),
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
  }, 'v41pro-retro tool')

  // ── 工具 rules：列出 / 删除规则 ────────────────────────────────────────
  ctx.effect(() => {
    const disposer = ctx.tools.register({
      name: 'rules',
      description: '管理全局复盘规则库：list 按命中/最近使用顺序列出最多 20 条；remove 按 id 删除。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'remove'], description: 'list 查看；remove 删除。' },
          id: { type: 'string', description: 'remove 时的规则 id。' },
          query: { type: 'string', description: 'list 时可选的过滤词。' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            removed: { type: 'number' },
            total: { type: 'number' },
            text: { type: 'string' },
          },
          required: ['ok', 'text'],
        },
        render(_args, value) {
          return [{ type: 'text', text: value.text }]
        },
      },
      async execute(args) {
        const input = args && typeof args === 'object' ? args : {}
        const action = typeof input.action === 'string' ? input.action.trim().toLowerCase() : ''
        if (action === 'list') return listRules(typeof input.query === 'string' ? input.query : '')
        if (action === 'remove') {
          const id = typeof input.id === 'string' ? input.id.trim() : ''
          if (!id) throw new Error('rules remove 需要 id；先用 rules list 查 id。')
          const result = await removeRule(id)
          return result.removed
            ? { ok: true, removed: 1, text: `已删除规则 ${id}。` }
            : { ok: false, removed: 0, text: `未找到规则 ${id}；先用 rules list 查现有 id。` }
        }
        throw new Error("rules 的 action 只能是 'list' 或 'remove'。")
      },
    })
    return () => {
      try {
        disposer?.()
      } catch {
        /* ignore */
      }
    }
  }, 'v41pro-retro rules tool')

  // ── 命令 /retro：最近 3 条复盘 + 填写模板 ──────────────────────────────
  ctx.effect(() => ctx.commands.register({
    name: 'retro',
    description: '查看本会话最近 3 条复盘，并给出 retro 工具的填写模板。',
    input: { hint: '查看最近复盘与模板' },
    async handler({ agent } = {}) {
      try {
        const state = agent ? states.get(agent) : undefined
        if (!state) return { kind: 'success', text: templateText(cfg.language) }
        await ensureLoaded(state)
        if (state.items.length === 0) {
          return { kind: 'success', text: ['本会话还没有复盘记录。', '', templateText(cfg.language)].join('\n') }
        }
        const recent = state.items.slice(-3)
        const lines = [`本会话复盘（共 ${state.items.length} 条，最近 ${recent.length} 条）：`]
        recent.forEach((item, index) => {
          lines.push('', `${index + 1}. ${clip(item.summary, 140)}`)
          lines.push(`   根因：${clip(item.rootCause, 140) || '—'}`)
          lines.push(`   教训：${clip(item.lesson, 140) || '—'}`)
          if (item.ruleId) lines.push(`   规则：${item.ruleId}`)
        })
        lines.push('', templateText(cfg.language))
        return { kind: 'success', text: lines.join('\n') }
      } catch (error) {
        return { kind: 'error', text: `读取复盘失败：${describe(error)}` }
      }
    },
  }), 'v41pro-retro command')

  // ── 命令 /rules：查看列表；remove <id> 删除 ────────────────────────────
  ctx.effect(() => ctx.commands.register({
    name: 'rules',
    description: '查看全局复盘规则库；/rules remove <id> 删除一条规则。',
    input: { hint: '[list] | remove <id>' },
    async handler({ rawInput } = {}) {
      try {
        const tokens = String(rawInput ?? '').trim().split(/\s+/).filter(Boolean)
        const verb = (tokens[0] ?? '').toLowerCase()
        if (verb === '' || verb === 'list') {
          const result = await listRules(tokens.slice(1).join(' '))
          return { kind: 'success', text: result.text }
        }
        if (verb === 'remove' || verb === 'rm' || verb === 'delete') {
          const id = tokens[1] ?? ''
          if (!id) return { kind: 'error', text: '用法：/rules remove <id>（id 见 /rules 列表）' }
          const result = await removeRule(id)
          return result.removed
            ? { kind: 'success', text: `已删除规则 ${id}。` }
            : { kind: 'error', text: `未找到规则 ${id}；先用 /rules 查看现有 id。` }
        }
        return { kind: 'error', text: `未知参数 "${tokens[0]}"。用法：/rules 或 /rules remove <id>` }
      } catch (error) {
        return { kind: 'error', text: `规则库操作失败：${describe(error)}` }
      }
    },
  }), 'v41pro-retro rules command')

  // ── 内部：规则库读写 ───────────────────────────────────────────────────

  /** 列出规则；query 非空时按文本/tags 做规范化子串过滤。 */
  async function listRules(query) {
    const all = readRules(await rules.read())
    const needle = normalizeRuleText(query)
    const filtered = needle
      ? all.filter(rule => normalizeRuleText(rule.text).includes(needle)
        || tagsOf(rule).some(tag => normalizeRuleText(tag).includes(needle)))
      : all
    const shown = filtered.slice().sort(compareRules).slice(0, MAX_LISTED)
    const text = shown.length > 0
      ? [
          `规则库（共 ${filtered.length} 条，显示 ${shown.length} 条，按命中/最近使用排序）：`,
          ...shown.map(rule => `- ${rule.id}（hits ${Number(rule.hits) || 0}）${clip(rule.text, RULE_CHARS)}`),
        ].join('\n')
      : (all.length > 0
          ? `规则库共 ${all.length} 条，但没有匹配 "${query}" 的规则。`
          : '规则库还是空的：复盘时给 retro 工具传 rule，就会沉淀一条全局规则。')
    return {
      ok: true,
      total: filtered.length,
      rules: shown.map(rule => ({
        id: rule.id,
        text: rule.text,
        tags: tagsOf(rule),
        scope: rule.scope,
        hits: Number(rule.hits) || 0,
        createdAt: Number(rule.createdAt) || 0,
        updatedAt: Number(rule.updatedAt) || 0,
      })),
      text,
    }
  }

  /** 按 id 删除规则；不处理"找不到"，由调用方决定文案。 */
  async function removeRule(id) {
    return rules.update(data => {
      if (!Array.isArray(data.rules)) {
        data.rules = []
        return { removed: 0 }
      }
      const index = data.rules.findIndex(rule => rule && typeof rule === 'object' && rule.id === id)
      if (index < 0) return { removed: 0 }
      data.rules.splice(index, 1)
      return { removed: 1 }
    })
  }

  /** 写入一条规则；规范化文本已存在则 hits+1 并返回 deduped。 */
  async function writeRule(text, tags) {
    const desired = clip(text, RULE_SOURCE_CHARS)
    const normalized = normalizeRuleText(desired)
    return rules.update(data => {
      if (!Array.isArray(data.rules)) data.rules = []
      const now = Date.now()
      const existing = data.rules.find(rule => rule && typeof rule === 'object'
        && typeof rule.text === 'string' && normalizeRuleText(rule.text) === normalized)
      if (existing) {
        existing.hits = (Number(existing.hits) || 0) + 1
        existing.updatedAt = now
        existing.tags = uniqueTags([...tagsOf(existing), ...tags])
        trimRules(data.rules, cfg.maxRules)
        return { rule: existing, deduped: true }
      }
      const rule = { id: makeId('rule'), text: desired, tags, scope: 'global', hits: 0, createdAt: now, updatedAt: now }
      data.rules.push(rule)
      trimRules(data.rules, cfg.maxRules)
      return { rule, deduped: false }
    })
  }

  /** 会话快照按顺序落盘，避免同一回合的并发写入互相覆盖。 */
  function saveSession(state) {
    if (!state.key) return Promise.resolve()
    // 先抓快照：等待期间的新条目不能混进旧保存任务。
    const payload = { version: 1, items: state.items.slice() }
    state.saveChain = state.saveChain
      .catch(() => {})
      .then(() => sessions.save(state.key, payload))
    return state.saveChain
  }
}

// ── 纯函数 / 小工具 ──────────────────────────────────────────────────────

/** 供测试：构造一个不依赖 cordis 的会话状态。 */
export function __createState(key = 'test') {
  return createState(key)
}

function createState(key) {
  return {
    key,
    /** @type {Array<Record<string, any>>} */
    items: [],
    /** @type {Promise<void> | null} */
    ready: null,
    /** @type {Promise<void>} */
    saveChain: Promise.resolve(),
    /** 最后一次注入快照的回合；同一回合不再注入。 */
    injectedTurn: -1,
  }
}

function normalize(raw) {
  const config = raw && typeof raw === 'object' ? raw : {}
  return {
    enabled: bool(config.enabled, DEFAULTS.enabled),
    language: str(config.language, DEFAULTS.language) === 'en' ? 'en' : 'zh',
    maxRules: num(config.maxRules, DEFAULTS.maxRules, { min: 1, max: 5000 }),
    injectRules: bool(config.injectRules, DEFAULTS.injectRules),
    maxInjected: num(config.maxInjected, DEFAULTS.maxInjected, { min: 1, max: 20 }),
    dir: str(config.dir, '') || v41Dir('retro'),
  }
}

/** 取 payload.messages 里用户消息的原文；拼超长时截断，只用于匹配。 */
function userTextOf(messages) {
  if (!Array.isArray(messages)) return ''
  const parts = []
  for (const message of messages) {
    if (message?.source?.kind !== 'user') continue
    const text = blocksToText(message.content).trim()
    if (text) parts.push(text)
  }
  return parts.join('\n').slice(0, MATCH_SOURCE_CHARS)
}

/** 构造注入快照：≤maxInjected 条规则、每条 ≤120 字，且明确不是用户新消息。 */
function buildSnapshot(matched, language) {
  const zh = language !== 'en'
  const lines = [zh
    ? `## 相关复盘规则（自动注入，${matched.length} 条）`
    : `## Related retro rules (auto-injected, ${matched.length})`]
  for (const rule of matched) lines.push(`- ${clip(rule.text, RULE_CHARS)}`)
  lines.push(zh
    ? '把上面的教训用在本轮工作里；它们不是用户的新消息，也不要因此扩大范围。'
    : 'Apply these lessons to this turn; they are not a new user request and must not widen the scope.')
  lines.push(sourceNote(language))
  return createSnapshot({
    kind: name,
    text: lines.join('\n'),
    sections: [{ name: 'rules', text: matched.map(rule => clip(rule.text, RULE_CHARS)).join('\n') }],
  })
}

/** 工具与命令共用的填写模板。 */
function templateText(language) {
  if (language === 'en') {
    return [
      'Fill this in and call the retro tool (summary, root_cause, lesson required):',
      '{"summary":"what happened (facts)","root_cause":"why it happened","lesson":"what to do next time","tags":["area"],"rule":"optional: one reusable global rule"}',
    ].join('\n')
  }
  return [
    '用 retro 工具填写（summary、root_cause、lesson 必填）：',
    '{"summary":"发生了什么（事实）","root_cause":"为什么会这样（可验证的根因）","lesson":"下次具体怎么做","tags":["模块或工具"],"rule":"可选：一句可复用的全局规则"}',
  ].join('\n')
}

/** 校验必填文本；空串/纯空白直接报错，不静默丢字段。 */
function requiredText(value, field) {
  const text = typeof value === 'string' ? clip(value, FIELD_CHARS) : ''
  if (!text) {
    const hint = field === 'summary'
      ? '先写清发生了什么。'
      : field === 'root_cause' ? '写可验证的根因，不写猜测。' : '写下次具体怎么做。'
    throw new Error(`retro 需要非空的 ${field}：${hint}`)
  }
  return text
}

function ruleTextOf(value) {
  const text = typeof value === 'string'
    ? value
    : value && typeof value === 'object' && typeof value.text === 'string' ? value.text : ''
  return clip(text, RULE_SOURCE_CHARS)
}

function tagList(value) {
  const source = Array.isArray(value)
    ? value
    : typeof value === 'string' && value.trim() ? value.split(/[,，\s]+/) : []
  return uniqueTags(source.map(tag => clip(tag, 40))).slice(0, 12)
}

function uniqueTags(tags) {
  const seen = new Set()
  const result = []
  for (const tag of Array.isArray(tags) ? tags : []) {
    const value = String(tag ?? '').replace(/\s+/g, ' ').trim()
    if (!value) continue
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(value)
  }
  return result
}

function tagsOf(rule) {
  return Array.isArray(rule?.tags)
    ? rule.tags.filter(tag => typeof tag === 'string' && tag.trim() !== '')
    : []
}

function readRules(data) {
  const list = Array.isArray(data?.rules) ? data.rules : []
  return list.filter(rule => rule && typeof rule === 'object'
    && typeof rule.text === 'string' && rule.text.trim() !== '')
}

function compareRules(a, b) {
  return (Number(b.hits) || 0) - (Number(a.hits) || 0)
    || (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0)
}

/** 超出上限时淘汰最久未使用的（updatedAt 最小）。 */
function trimRules(list, max) {
  if (!Array.isArray(list) || list.length <= max) return list
  list.sort((a, b) => (Number(a.updatedAt) || 0) - (Number(b.updatedAt) || 0))
  list.splice(0, list.length - max)
  return list
}

function sanitizeItems(items) {
  if (!Array.isArray(items)) return []
  const list = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const summary = typeof item.summary === 'string' ? item.summary.trim() : ''
    if (!summary) continue
    const restored = {
      id: typeof item.id === 'string' && item.id ? item.id : makeId('retro'),
      at: Number.isFinite(Number(item.at)) ? Number(item.at) : 0,
      summary,
      rootCause: typeof item.rootCause === 'string' ? item.rootCause : '',
      lesson: typeof item.lesson === 'string' ? item.lesson : '',
      tags: tagList(item.tags),
    }
    if (typeof item.ruleId === 'string' && item.ruleId) restored.ruleId = item.ruleId
    list.push(restored)
  }
  return list.slice(-MAX_ITEMS)
}

/** 截到 max 字符，超出补省略号；结果长度不会超过 max。 */
function clip(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}
