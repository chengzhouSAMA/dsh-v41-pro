/**
 * v41pro-novel —— 长篇小说工作区。
 *
 * 开启小说时建立大纲与数据库，每回合从磁盘重读并注入现状卡，防止长会话偏题。
 * 用户要求单独存进 userRequirements，可标记废弃（保留历史）。
 * 所有文件写入走「临时文件 + rename」，进程被杀不会留下半个 JSON。
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

import { bool, makeLogger, num, str } from './core/config.js'
import { createAgentStore, sessionKey } from './core/state.js'
import { createSnapshot } from './core/message.js'
import { truncate } from './core/util.js'

export const name = 'v41pro-novel'
export const inject = ['tools']

export const DEFAULTS = {
  enabled: true,
  dir: '',
  maxArcs: 50,
  maxChapters: 500,
  maxRequirements: 100,
  maxFacts: 300,
  language: 'zh',
}

function createState() {
  return {
    workId: '',
    turn: 0,
    /** 上次注入的回合；同一回合只注入一次。 */
    lastCardTurn: -1,
  }
}

/** 空的数据库。 */
function emptyData(workId, title, genre, premise) {
  return {
    version: 1,
    workId,
    title: title || '未命名小说',
    genre: genre || '',
    premise: premise || '',
    status: 'drafting',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    outline: { arcs: [] },
    userRequirements: [],
    facts: { characters: [], timeline: [], threads: [] },
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
    logger.info('enabled=false，小说工作区已关闭')
    return
  }

  const states = createAgentStore(createState)
  const store = new NovelStore(cfg, logger)
  /** @type {Promise<void>} */
  let writeChain = Promise.resolve()

  /** 当前会话指针：sessionId → workId。 */
  function pointerFileFor(sessionId) {
    const safe = String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
    return path.join(store.dir, 'pointers', `${safe || 'session'}.txt`)
  }

  async function resolveWorkId(agent) {
    const sessionId = sessionKey(agent)
    if (!sessionId) return ''
    try {
      return (await fsp.readFile(pointerFileFor(sessionId), 'utf8')).trim()
    } catch {
      return ''
    }
  }

  function rememberWorkId(agent, workId) {
    const sessionId = sessionKey(agent)
    if (!sessionId) return
    const file = pointerFileFor(sessionId)
    writeChain = writeChain.then(async () => {
      await fsp.mkdir(path.dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      await fsp.writeFile(tmp, workId, 'utf8')
      await fsp.rename(tmp, file)
    }).catch(() => {})
  }

  // ── 每回合注入现状卡 ──────────────────────────────────────────────────────
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    let card
    try {
      if (decision?.kind === 'enter') {
        const state = states.get(payload.agent)
        if (!state.workId) state.workId = await resolveWorkId(payload.agent)
        if (state.workId && state.lastCardTurn !== payload.turn) {
          state.lastCardTurn = payload.turn
          const data = await store.load(state.workId)
          if (data) card = buildCard(data, payload.turn, cfg)
        }
      }
    } catch (error) {
      logger.warn('小说现状卡注入失败：', error instanceof Error ? error.message : error)
    }
    if (!card) return decision
    return { ...decision, messages: [card, ...decision.messages] }
  })

  // ── 会话销毁：清理内存状态 ────────────────────────────────────────────────
  ctx.on('agent/disposed', ({ agent }) => {
    states.delete(agent)
  })

  // ── pro_novel 工具 ─────────────────────────────────────────────────────────
  ctx.effect(() => {
    const disposer = ctx.tools.register({
      name: 'pro_novel',
      description: [
        '管理长篇小说的工作区：开启小说时建立大纲与数据库；每回合自动注入大纲、活跃用户要求与连续性事实，防止偏题。',
        'action=init 开启/切换小说；action=outline 增改大纲；action=requirement 记录用户要求（active=false 表示废弃，保留历史）；action=fact 记录人物/时间线/伏笔事实；action=status 更新写作状态。',
        '不要用普通聊天或临时文件代替这份数据库。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['init', 'outline', 'requirement', 'fact', 'status'] },
          workId: { type: 'string', description: '切换或定位已有作品；init 时可省略，自动生成。' },
          title: { type: 'string' },
          genre: { type: 'string' },
          premise: { type: 'string' },
          arcTitle: { type: 'string' },
          arcGoal: { type: 'string' },
          arcSummary: { type: 'string' },
          chapterTitle: { type: 'string' },
          chapterSummary: { type: 'string' },
          requirement: { type: 'string' },
          active: { type: 'boolean', description: 'requirement 用：false 表示废弃该要求。' },
          reason: { type: 'string', description: '废弃要求时记录原因。' },
          kind: { type: 'string', enum: ['character', 'timeline', 'thread'] },
          factName: { type: 'string' },
          factSummary: { type: 'string' },
          status: { type: 'string', enum: ['drafting', 'paused', 'done'] },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { workId: { type: 'string' }, summary: { type: 'string' } },
          required: ['workId', 'summary'],
          additionalProperties: false,
        },
        render(_args, value) {
          return [{ type: 'text', text: value.summary }]
        },
      },
      async execute(args, exec) {
        const input = args && typeof args === 'object' ? args : {}
        const agent = exec?.agent
        const state = agent ? states.get(agent) : null

        const activeWorkId = state?.workId || input.workId || ''
        const data = activeWorkId ? await store.load(activeWorkId) : null

        if (input.action === 'init') {
          const workId = input.workId || `${slug(input.title || 'novel')}-${randomBytes(2).toString('hex')}`
          const fresh = emptyData(workId, input.title, input.genre, input.premise)
          await store.save(fresh)
          if (state) state.workId = workId
          if (agent) rememberWorkId(agent, workId)
          return { workId, summary: summaryOf(fresh, cfg) }
        }

        if (!data) throw new Error('当前没有小说。先用 pro_novel action=init 开启或指定 workId。')

        if (input.action === 'outline') {
          addOutline(data, input, cfg)
        } else if (input.action === 'requirement') {
          addRequirement(data, input, cfg)
        } else if (input.action === 'fact') {
          addFact(data, input, cfg)
        } else if (input.action === 'status' && input.status) {
          data.status = input.status
        }

        data.updatedAt = Date.now()
        await store.save(data)
        if (state) state.workId = data.workId
        return { workId: data.workId, summary: summaryOf(data, cfg) }
      },
    })

    return () => {
      try {
        disposer?.()
      } catch {
        /* ignore */
      }
    }
  }, 'v41pro-novel tool')
}

function addOutline(data, input, cfg) {
  if (input.arcTitle) {
    if (data.outline.arcs.length >= cfg.maxArcs) return
    data.outline.arcs.push({
      id: `arc-${data.outline.arcs.length + 1}`,
      title: truncate(input.arcTitle, 80),
      goal: truncate(input.arcGoal || '', 200),
      summary: truncate(input.arcSummary || '', 400),
      chapters: [],
    })
    return
  }
  if (input.chapterTitle) {
    const arc = data.outline.arcs[data.outline.arcs.length - 1]
    if (!arc) return
    if (data.outline.arcs.reduce((n, a) => n + a.chapters.length, 0) >= cfg.maxChapters) return
    arc.chapters.push({ id: `ch-${arc.chapters.length + 1}`, title: truncate(input.chapterTitle, 80), summary: truncate(input.chapterSummary || '', 300) })
  }
}

function addRequirement(data, input, cfg) {
  if (!input.requirement) return
  const text = truncate(input.requirement, 500)
  const existing = data.userRequirements.find(r => r.text === text)
  if (existing) {
    existing.active = input.active !== false
    existing.updatedAt = Date.now()
    if (input.active === false) {
      existing.removedAt = Date.now()
      existing.reason = truncate(input.reason || '', 200)
    } else {
      existing.removedAt = undefined
      existing.reason = ''
    }
    return
  }
  data.userRequirements.push({
    id: `req-${data.userRequirements.length + 1}`,
    text,
    active: input.active !== false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...(input.active === false ? { removedAt: Date.now(), reason: truncate(input.reason || '', 200) } : {}),
  })
  if (data.userRequirements.length > cfg.maxRequirements) data.userRequirements.splice(0, data.userRequirements.length - cfg.maxRequirements)
}

function addFact(data, input, cfg) {
  const kind = input.kind || 'character'
  const bucket = data.facts[kind] || (data.facts[kind] = [])
  if (bucket.length >= cfg.maxFacts) return
  bucket.push({ name: truncate(input.factName || '', 80), summary: truncate(input.factSummary || '', 300), updatedAt: Date.now() })
}

function buildCard(data, turn, cfg) {
  const zh = cfg.language !== 'en'
  const arcs = data.outline.arcs
  const activeReqs = data.userRequirements.filter(r => r.active)
  const lines = []
  lines.push(zh ? `## 小说现状卡（第 ${turn} 回合，自动注入）` : `## Novel state card (turn ${turn}, injected)`)
  lines.push('', zh ? `**作品**：${data.title}` : `**Work**: ${data.title}`)
  if (data.genre) lines.push(zh ? `**类型**：${data.genre}` : `**Genre**: ${data.genre}`)
  if (data.premise) lines.push(zh ? `**核心前提**：${data.premise}` : `**Premise**: ${data.premise}`)
  if (arcs.length > 0) {
    lines.push('', zh ? '**大纲**：' : '**Outline**:')
    for (const arc of arcs) {
      lines.push(`- ${arc.title}${arc.goal ? `（目标：${arc.goal}）` : ''}${arc.chapters.length ? ` [${arc.chapters.length} 章]` : ''}`)
    }
  } else {
    lines.push('', zh ? '**大纲**：（尚未建立，先规划分卷/主线再动笔）' : '**Outline**: (not created yet)')
  }
  if (activeReqs.length > 0) {
    lines.push('', zh ? '**当前用户要求**：' : '**Active user requirements**:')
    for (const req of activeReqs) lines.push(`- ${req.text}`)
  }
  const characters = data.facts.characters
  const threads = data.facts.threads
  if (characters.length > 0) {
    lines.push('', zh ? '**人物**：' : '**Characters**:')
    for (const c of characters.slice(-20)) lines.push(`- ${c.name}：${c.summary}`)
  }
  if (threads.length > 0) {
    lines.push('', zh ? '**伏笔/线索**：' : '**Threads**:')
    for (const t of threads.slice(-20)) lines.push(`- ${t.name}：${t.summary}`)
  }
  lines.push('', zh
    ? '写新内容前先对照本卡；与大纲或活跃要求冲突时先更新数据库，再继续。需要完整章节细节时用 pro_novel 查询，不要凭印象续写。'
    : 'Check this card before writing; update the database when the outline or requirements change. Query pro_novel for details instead of relying on memory.')
  lines.push('', zh ? '（这是 harness 自动注入的系统提示，不是用户的新消息。）' : '(Automatic harness note, not a new user message.)')
  const text = lines.join('\n')
  return createSnapshot({
    kind: 'v41pro-novel',
    text,
    sections: [
      { name: 'title', text: data.title },
      ...(activeReqs.length ? [{ name: 'requirements', text: activeReqs.map(r => r.text).join('\n') }] : []),
      ...(arcs.length ? [{ name: 'outline', text: arcs.map(a => a.title).join('\n') }] : []),
    ],
    extra: { workId: data.workId },
  })
}

function summaryOf(data, cfg) {
  const active = data.userRequirements.filter(r => r.active).length
  const chapters = data.outline.arcs.reduce((n, a) => n + a.chapters.length, 0)
  const zh = cfg.language !== 'en'
  return zh
    ? `${data.title}｜类型 ${data.genre || '未定'}｜卷 ${data.outline.arcs.length}｜章 ${chapters}｜活跃要求 ${active}｜状态 ${data.status}`
    : `${data.title} | genre ${data.genre || 'TBD'} | arcs ${data.outline.arcs.length} | chapters ${chapters} | active reqs ${active} | ${data.status}`
}

function slug(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'novel'
}

class NovelStore {
  constructor(cfg, logger) {
    this.cfg = cfg
    this.logger = logger
    this.dir = cfg.dir || defaultDir()
  }

  fileFor(workId) {
    const safe = String(workId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
    return path.join(this.dir, `${safe || 'novel'}.json`)
  }

  async load(workId) {
    try {
      const raw = await fsp.readFile(this.fileFor(workId), 'utf8')
      const data = JSON.parse(raw)
      if (data?.version !== 1) return null
      return data
    } catch {
      return null
    }
  }

  async save(data) {
    await fsp.mkdir(this.dir, { recursive: true })
    const file = this.fileFor(data.workId)
    const tmp = `${file}.${process.pid}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(data), 'utf8')
    await fsp.rename(tmp, file)
  }
}

function defaultDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'v41pro', 'novel')
}

function normalize(raw, logger) {
  const config = raw && typeof raw === 'object' ? raw : {}
  return {
    enabled: bool(config.enabled, DEFAULTS.enabled),
    dir: str(config.dir, DEFAULTS.dir),
    maxArcs: num(config.maxArcs, DEFAULTS.maxArcs, { min: 1 }),
    maxChapters: num(config.maxChapters, DEFAULTS.maxChapters, { min: 1 }),
    maxRequirements: num(config.maxRequirements, DEFAULTS.maxRequirements, { min: 1 }),
    maxFacts: num(config.maxFacts, DEFAULTS.maxFacts, { min: 1 }),
    language: str(config.language, DEFAULTS.language) === 'en' ? 'en' : 'zh',
  }
}
