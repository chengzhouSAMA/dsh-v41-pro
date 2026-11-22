/**
 * DSH Reasoning Max 3.0 —— Python 单文件架构的 JS 移植（供 v41pro-thinking 调用）。
 *
 * 移植原则：
 *  - 不引入 HTTP/API key：所有模型调用都走宿主 ctx.llm 的流式接口，由宿主负责路由与鉴权。
 *  - 不改模型权重；PRM 是 LLM-as-judge 的噪声代理，RL 层只学“模型选择策略”并导出训练数据。
 *  - 推理步骤是短小、可核查的推导，不要求模型输出隐藏的逐字思维链。
 *  - token 预算按字符粗估（≈2 字符/token），时间预算按墙钟；都是软约束，不会杀进程。
 *
 * 版本线对应：1.0 并行候选+critic；1.5 MCTS；2.0 PRM；2.5 自适应算力；3.0 多模型路由+RL 数据。
 */

import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const RMAX_VERSION = '3.0-js'
export const ROLES = Object.freeze(['generator', 'prm', 'critic', 'synthesizer'])
export const TIERS = Object.freeze(['low', 'medium', 'high'])
const RANK = { none: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6 }
const TIER_RANK = { low: 2, medium: 4, high: 6 }

export const TIER_PRESETS = Object.freeze({
  low: { parallelCandidates: 1, mctsIterations: 0, branching: 0, maxDepth: 0, prmSamples: 1, refineRounds: 0, tokenBudget: 8_000, timeBudget: 90 },
  medium: { parallelCandidates: 2, mctsIterations: 6, branching: 2, maxDepth: 5, prmSamples: 1, refineRounds: 1, tokenBudget: 60_000, timeBudget: 240 },
  high: { parallelCandidates: 3, mctsIterations: 14, branching: 3, maxDepth: 7, prmSamples: 2, refineRounds: 1, tokenBudget: 220_000, timeBudget: 600 },
})

export const DEFAULTS = Object.freeze({
  enabled: true,
  mode: 'auto',
  workers: 3,
  uctC: 1.1,
  pruneThreshold: 0.25,
  maxRefine: 1,
  iterations: 0,
  tokenBudget: 0,
  timeBudget: 0,
  routerEpsilon: 0.1,
  routerLearn: true,
  modelPool: [],
  callTimeoutMs: 120_000,
  maxQuestion: 8_000,
  language: 'zh',
  stateDir: '',
})

/** 配置来自插件行，容忍字符串/缺省；未知键忽略。 */
export function normalizeConfig(raw = {}) {
  const c = raw && typeof raw === 'object' ? raw : {}
  const num = (value, fallback, min, max) => {
    const n = Number(value)
    if (!Number.isFinite(n)) return fallback
    return Math.min(max, Math.max(min, n))
  }
  return {
    enabled: c.enabled !== false,
    mode: ['auto', 'ensemble', 'mcts'].includes(c.mode) ? c.mode : DEFAULTS.mode,
    workers: Math.round(num(c.workers, DEFAULTS.workers, 1, 8)),
    uctC: num(c.uctC, DEFAULTS.uctC, 0, 5),
    pruneThreshold: num(c.pruneThreshold, DEFAULTS.pruneThreshold, 0, 1),
    maxRefine: Math.round(num(c.maxRefine, DEFAULTS.maxRefine, 0, 4)),
    iterations: Math.round(num(c.iterations, DEFAULTS.iterations, 0, 40)),
    tokenBudget: Math.round(num(c.tokenBudget, DEFAULTS.tokenBudget, 0, 5_000_000)),
    timeBudget: num(c.timeBudget, DEFAULTS.timeBudget, 0, 3_600),
    routerEpsilon: num(c.routerEpsilon, DEFAULTS.routerEpsilon, 0, 1),
    routerLearn: c.routerLearn !== false,
    modelPool: Array.isArray(c.modelPool) ? c.modelPool : [],
    callTimeoutMs: Math.round(num(c.callTimeoutMs, DEFAULTS.callTimeoutMs, 5_000, 900_000)),
    maxQuestion: Math.round(num(c.maxQuestion, DEFAULTS.maxQuestion, 200, 40_000)),
    language: c.language === 'en' ? 'en' : 'zh',
    stateDir: typeof c.stateDir === 'string' ? c.stateDir : '',
  }
}

export function stateDir(cfg = {}) {
  return cfg.stateDir || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'v41pro', 'reasoning-max')
}

const clamp01 = value => Math.max(0, Math.min(1, value))
const safeFloat = (value, fallback = 0) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}
const estimateTokens = text => Math.max(1, Math.round(String(text ?? '').length / 2))
const clip = (text, n) => {
  const value = String(text ?? '')
  return value.length <= n ? value : `${value.slice(0, n)}…[已截断]`
}
const normalizeStep = text => String(text ?? '').replace(/\s+/g, '').toLowerCase().slice(0, 80)
const FINAL_RE = /^\s*(最终答案|最终结论|final answer)\s*[:：]/i

export function parseJsonObject(text) {
  const raw = String(text ?? '')
  if (!raw) return null
  const candidates = [raw]
  const match = /\{[\s\S]*\}/.exec(raw)
  if (match) candidates.push(match[0])
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate)
      if (value && typeof value === 'object' && !Array.isArray(value)) return value
    } catch { /* 继续尝试 */ }
  }
  return null
}

const HIGH_MARKERS = ['证明', '定理', '复杂', '架构', '研究', '科研', '漏洞', '安全审计', '多步骤', '优化', '算法', '推导', '设计系统', 'debug', 'refactor', 'prove', 'theorem', 'research', 'architecture', 'multi-step', 'algorithm']
const MEDIUM_MARKERS = ['分析', '解释原因', '方案', '代码', '编程', '计划', '分析一下', 'analyze', 'explain', 'design', 'code', 'plan']

/** 2.5 难度路由：启发式，只决定编排预算，不是模型档位。 */
export function chooseEffort(question) {
  const q = String(question ?? '').toLowerCase()
  const hits = HIGH_MARKERS.filter(marker => q.includes(marker)).length
  const midHits = MEDIUM_MARKERS.filter(marker => q.includes(marker)).length
  if (hits >= 2 || q.length > 1200) return { tier: 'high', effort: 90 }
  if (hits === 1 || midHits >= 1 || q.length > 300) return { tier: 'medium', effort: 65 }
  return { tier: 'low', effort: 30 }
}

export const TIER_EFFORT = { low: 30, medium: 65, high: 90 }

/** 把配置、难度与模式合成一次搜索计划。 */
export function buildPlan(rawCfg, question, override) {
  const cfg = normalizeConfig(rawCfg)
  const route = chooseEffort(question)
  let tier = TIERS.includes(override?.tier) ? override.tier : route.tier
  let effort = TIER_EFFORT[tier]
  const mode = ['auto', 'ensemble', 'mcts'].includes(override?.mode) ? override.mode : cfg.mode
  if (mode === 'mcts' && tier === 'low') {
    tier = 'medium'
    effort = TIER_EFFORT.medium
  }
  const preset = { ...TIER_PRESETS[tier] }
  const forced = TIERS.includes(override?.tier)
  const fastPath = mode === 'auto' && tier === 'low' && !forced
  const useMcts = (mode === 'auto' || mode === 'mcts') && !fastPath && tier !== 'low'
  const useCandidates = mode !== 'mcts'
  if (mode === 'ensemble') {
    preset.parallelCandidates = 4
    preset.mctsIterations = 0
  }
  if (mode === 'mcts') preset.parallelCandidates = 0
  if (tier !== 'low') preset.refineRounds = cfg.maxRefine
  const iterations = Math.max(0, Math.round(Number(override?.iterations) || 0))
  if (iterations > 0 && useMcts) preset.mctsIterations = iterations
  const tokenBudget = Math.max(0, Math.round(Number(override?.tokenBudget) || 0))
  if (tokenBudget > 0) preset.tokenBudget = tokenBudget
  const timeBudget = Math.max(0, Number(override?.timeBudget) || 0)
  if (timeBudget > 0) preset.timeBudget = timeBudget
  return {
    tier,
    effort,
    fastPath,
    useCandidates,
    useMcts,
    escalated: false,
    parallelCandidates: preset.parallelCandidates,
    mctsIterations: preset.mctsIterations,
    branching: preset.branching,
    maxDepth: preset.maxDepth,
    prmSamples: preset.prmSamples,
    refineRounds: preset.refineRounds,
    tokenBudget: preset.tokenBudget,
    timeBudget: preset.timeBudget,
  }
}

export class UsageMeter {
  constructor() {
    this.calls = 0
    this.totalTokens = 0
    this.byPurpose = {}
    this.byModel = {}
  }
  add(model, purpose, tokens) {
    const t = Math.max(0, Math.round(tokens))
    this.calls += 1
    this.totalTokens += t
    this.byPurpose[purpose] = (this.byPurpose[purpose] ?? 0) + t
    this.byModel[model] = (this.byModel[model] ?? 0) + t
  }
  snapshot() {
    return { calls: this.calls, totalTokens: this.totalTokens, byPurpose: { ...this.byPurpose }, byModel: { ...this.byModel } }
  }
}

/** token/时间预算：搜索阶段 80% 就让位给综合，100% 阻断非最终调用。 */
export class Budget {
  constructor(meter, maxTokens, maxSeconds, searchFraction = 0.8) {
    this.meter = meter
    this.maxTokens = maxTokens
    this.maxSeconds = maxSeconds
    this.searchFraction = searchFraction
    this.enforce = true
    this.startedAt = Date.now()
  }
  resetCaps(maxTokens, maxSeconds) {
    this.maxTokens = maxTokens
    this.maxSeconds = maxSeconds
  }
  elapsed() {
    return (Date.now() - this.startedAt) / 1000
  }
  over(fraction) {
    if (this.maxTokens > 0 && this.meter.totalTokens >= this.maxTokens * fraction) return true
    return this.maxSeconds > 0 && this.elapsed() >= this.maxSeconds * fraction
  }
  searchExhausted() {
    return this.over(this.searchFraction)
  }
  hardExhausted() {
    return this.enforce && this.over(1)
  }
}

export class BudgetExceeded extends Error {}

/** 3.0 UCB1+ε 路由器：每个 (role, tier) 一张表，臂是模型。 */
export class ModelRouter {
  constructor({ arms, epsilon = 0.1, learn = true, rng = Math.random, stats = {} } = {}) {
    this.arms = Array.isArray(arms) ? arms : []
    this.epsilon = epsilon
    this.learn = learn
    this.rng = rng
    this.stats = stats && typeof stats === 'object' ? stats : {}
  }
  armsFor(role) {
    const filtered = this.arms.filter(arm => arm.roles?.includes(role))
    return filtered.length ? filtered : this.arms
  }
  pick(role, tier, n = 1) {
    const arms = this.armsFor(role)
    if (!arms.length) throw new Error('模型池为空，无法选择模型')
    if (arms.length === 1) return Array.from({ length: n }, () => arms[0])
    const key = `${role}|${tier}`
    const table = this.stats[key] ?? {}
    const total = arms.reduce((sum, arm) => sum + (table[arm.name]?.[0] ?? 0), 0) + 1
    const scored = arms.map(arm => {
      const [count, rewardSum] = table[arm.name] ?? [0, 0]
      const ucb = count < 1 ? Infinity : rewardSum / count + 0.5 * Math.sqrt(Math.log(total) / count) - 0.03 * (arm.costWeight ?? 1)
      return { ucb, tie: this.rng(), arm }
    })
    if (this.rng() < this.epsilon) scored.sort(() => this.rng() - 0.5)
    else scored.sort((a, b) => (b.ucb - a.ucb) || (b.tie - a.tie))
    const ordered = scored.map(item => item.arm)
    return Array.from({ length: n }, (_v, i) => ordered[i % ordered.length])
  }
  update(modelsUsed, tier, reward, weight) {
    if (!this.learn || weight <= 0) return
    const value = clamp01(reward)
    for (const [role, names] of Object.entries(modelsUsed ?? {})) {
      const key = `${role}|${tier}`
      const table = this.stats[key] ?? (this.stats[key] = {})
      for (const name of new Set(Array.from(names ?? []))) {
        const arm = this.arms.find(item => item.name === name)
        if (!arm) continue
        const [count, sum] = table[name] ?? [0, 0]
        table[name] = [count + weight, sum + weight * value]
      }
    }
  }
  toJSON() {
    return this.stats
  }
}

export class SearchTree {
  constructor() {
    this.nodes = [{ id: 0, parent: null, depth: 0, step: '', model: '', children: [], visits: 0, valueSum: 0, prm: 0, prmStd: 0, prmValid: true, issue: '', pv: 0, terminal: false, expanded: false, pruned: false }]
  }
  add(parent, step, model, terminal) {
    const node = { id: this.nodes.length, parent, depth: this.nodes[parent].depth + 1, step, model, children: [], visits: 0, valueSum: 0, prm: 0, prmStd: 0, prmValid: true, issue: '', pv: 0, terminal: Boolean(terminal), expanded: false, pruned: false }
    this.nodes.push(node)
    this.nodes[parent].children.push(node.id)
    return node
  }
  path(id) {
    const out = []
    let node = this.nodes[id]
    while (node?.parent !== null && node) {
      out.push(node)
      node = this.nodes[node.parent]
      if (!node) break
    }
    return out.reverse()
  }
  steps(id) {
    return this.path(id).map(node => node.step)
  }
  backprop(id, value) {
    let node = this.nodes[id]
    while (node) {
      node.visits += 1
      node.valueSum += value
      node = node.parent === null ? null : this.nodes[node.parent]
    }
  }
  select(c) {
    let node = this.nodes[0]
    for (let guard = 0; guard < 10_000; guard += 1) {
      if (!node.expanded || !node.children.length || node.terminal) return node
      const live = node.children.map(id => this.nodes[id]).filter(child => !child.pruned)
      if (!live.length) {
        if (node.parent === null) return null
        node.pruned = true
        node = this.nodes[0]
        continue
      }
      const ln = Math.log(Math.max(node.visits, 1) + 1)
      let best = live[0]
      for (const child of live) {
        const q = child.visits ? child.valueSum / child.visits : 0
        const bq = best.visits ? best.valueSum / best.visits : 0
        if (q + c * Math.sqrt(ln / Math.max(child.visits, 1)) > bq + c * Math.sqrt(ln / Math.max(best.visits, 1))) best = child
      }
      node = best
    }
    return node
  }
  terminals() {
    return this.nodes.filter(node => node.terminal && node.visits > 0)
  }
  bestTerminal() {
    const terminals = this.terminals()
    return terminals.length ? terminals.reduce((best, node) => (node.pv > best.pv ? node : best)) : null
  }
}

export class AdaptiveController {
  constructor(plan, budget, options = {}) {
    this.plan = plan
    this.budget = budget
    this.iterLimit = plan.mctsIterations
    this.minIters = options.minIters ?? 2
    this.patience = options.patience ?? 4
    this.stopThreshold = options.stopThreshold ?? 0.85
    this.maxExtensions = options.maxExtensions ?? 2
    this.extensions = 0
    this.bestSeen = 0
    this.lastImprove = 0
  }
  check(tree, it) {
    if (this.budget.searchExhausted()) return { stop: true, reason: 'budget' }
    const best = tree.bestTerminal()
    const bv = best ? best.pv : 0
    if (best && bv > this.bestSeen + 1e-6) {
      this.bestSeen = bv
      this.lastImprove = it
    }
    if (best && it >= this.minIters && bv >= this.stopThreshold && best.prmStd <= 0.15) return { stop: true, reason: 'confident' }
    if (best && bv >= 0.7 && it - this.lastImprove >= this.patience) return { stop: true, reason: 'plateau' }
    if (it >= this.iterLimit) {
      if (best && bv >= 0.6) return { stop: true, reason: 'planned' }
      if (this.extensions < this.maxExtensions) {
        this.extensions += 1
        this.iterLimit += Math.max(2, Math.floor(this.plan.mctsIterations / 4))
        return { stop: false, reason: 'extended' }
      }
      return { stop: true, reason: 'planned_limit' }
    }
    return { stop: false, reason: '' }
  }
}

export function pathValue(scores, mode = 'blend') {
  if (!scores.length) return 0
  if (mode === 'min') return Math.min(...scores)
  if (mode === 'mean') return scores.reduce((a, b) => a + b, 0) / scores.length
  if (mode === 'last') return scores[scores.length - 1]
  return 0.5 * scores[scores.length - 1] + 0.5 * Math.min(...scores)
}

export function renderSteps(steps) {
  return steps.length ? steps.map((step, index) => `${index + 1}. ${step}`).join('\n') : '（无，这是第一步）'
}

const PRM_SYSTEM = '你是「过程奖励评审器」(PRM)。只评估【最新一步】是否正确、合理、有依据，并且是否推进了问题的解决。已有步骤仅作上下文；不要因为前文有问题而重复扣分，但如果最新一步依赖了前文的错误，要指出。不要因为措辞自信而加分。若最新一步是「最终答案」，同时检查整条步骤链是否真正支持该结论。只输出 JSON：{"score": 0到1的数字, "verdict": "correct|questionable|wrong", "issue": "一句话说明问题，没有则留空"}。不要输出隐含的逐字内部思维链。'

const STEP_SYSTEM = '你是树搜索推理系统中的「步骤生成器」。给定问题与已确定的推理步骤，只写出【下一步】：\n- 一步只做一件可检查的事（一次推导、一次计算、一个论断或一次排除），不超过150字；\n- 不要重复已有步骤；只写可被他人核查的步骤；\n- 如果现有步骤已足以回答问题，则以「最终答案：」开头，给出结论、关键依据、假设与不确定性；\n- 信息不足时直接说明，不要编造，也不要声称执行了未执行的验证。'
const STEP_HINTS = ['沿最直接、最常规的方法推进。', '换一种与常规不同的方法推进。', '先检查隐含假设或边界条件，再推进。', '从可验证、可执行的角度推进。', '先把问题拆成更小的子问题，处理其中一个。']

const BRANCHES = [
  ['独立主解', '独立求解问题，优先给出最直接、可检查的方案。'],
  ['替代路径', '使用不同于常规方法的路径求解，检查是否存在更简单或更稳健的方法。'],
  ['反例与边界', '尝试寻找反例、边界条件、隐藏假设和可能导致答案失败的情形。'],
  ['实践验证', '从可执行性和实际验证角度分析；若涉及代码，给出测试思路，但不要声称未运行的代码已经通过测试。'],
]

const JUDGE_SYSTEM = '你是独立的答案评审器。不要因为某个候选答案写得更自信就偏向它。检查事实、逻辑、假设、边界条件和候选之间的分歧。候选标注的「过程评分」来自自动评审，只是参考信号，不是事实依据。请输出 JSON，字段为: verdict（可接受/需修正/信息不足）, issues（数组）, best_supported_conclusion（字符串）, confidence（0到1数字）, verification_plan（数组）。不要输出隐含的逐字内部思维链。'

const SEVERITY = { 可接受: 0, 需修正: 1, 信息不足: 2 }

export function mergeJudges(judges) {
  if (!judges.length) return { verdict: '需修正', issues: ['评审调用失败。'], best_supported_conclusion: '', confidence: 0, verification_plan: [] }
  if (judges.length === 1) return judges[0]
  const worst = judges.reduce((a, b) => ((SEVERITY[b.verdict] ?? 1) > (SEVERITY[a.verdict] ?? 1) ? b : a))
  const leader = judges.reduce((a, b) => (safeFloat(b.confidence) > safeFloat(a.confidence) ? b : a))
  const issues = []
  for (const judge of judges) for (const issue of judge.issues ?? []) if (!issues.includes(String(issue))) issues.push(String(issue))
  return { verdict: worst.verdict ?? '需修正', issues, best_supported_conclusion: leader.best_supported_conclusion ?? '', confidence: judges.reduce((sum, judge) => sum + safeFloat(judge.confidence), 0) / judges.length, verification_plan: leader.verification_plan ?? [] }
}

export function proxyReward(judge, bestPv) {
  const base = { 可接受: 1, 需修正: 0.55, 信息不足: 0.35 }[judge?.verdict] ?? 0.5
  const parts = [clamp01(safeFloat(judge?.confidence)) * base]
  if (bestPv !== null && bestPv !== undefined) parts.push(clamp01(bestPv))
  return Math.round((parts.reduce((a, b) => a + b, 0) / parts.length) * 10_000) / 10_000
}

function textOf(message) {
  if (!message) return ''
  if (typeof message.content === 'string') return message.content
  return (message.content ?? []).filter(block => block?.type === 'text').map(block => block.text).join('\n')
}

async function appendJsonl(file, value) {
  await mkdir(dirname(file), { recursive: true })
  await appendFile(file, `${JSON.stringify(value)}\n`, 'utf8')
}

export function buildModelPool(cfg, selection) {
  const entries = (cfg.modelPool ?? []).filter(item => item && typeof item.model === 'string' && item.model.trim())
  const specs = entries.map(item => {
    const provider = typeof item.provider === 'string' && item.provider.trim() ? item.provider.trim() : selection?.provider
    const roles = Array.isArray(item.roles) ? item.roles.filter(role => ROLES.includes(role)) : [...ROLES]
    return { provider, model: item.model.trim(), name: `${provider}/${item.model.trim()}`, roles: roles.length ? roles : [...ROLES], costWeight: Math.max(0.01, safeFloat(item.costWeight, 1)) }
  }).filter(spec => spec.provider)
  if (specs.length) return specs
  if (!selection?.provider || !selection?.model) throw new Error('当前会话没有可选模型，无法启动 Reasoning Max')
  return [{ provider: selection.provider, model: selection.model, name: `${selection.provider}/${selection.model}`, roles: [...ROLES], costWeight: 1 }]
}

/** 真实调用适配器：把宿主 llm.stream 包装成统一的 chat(options) -> text。 */
export function createLlmChat(llm, selection, cfg = {}) {
  const settings = normalizeConfig(cfg)
  const effortCache = new Map()
  async function effortFor(provider, model, tier) {
    const key = `${provider}/${model}/${tier}`
    if (effortCache.has(key)) return effortCache.get(key)
    let info
    try {
      info = await llm.resolveModelInfo(provider, model)
    } catch { info = null }
    const allowed = (info?.reasoning?.efforts ?? []).map(item => item.id)
    const target = TIER_RANK[tier] ?? 4
    const ordered = [...allowed].sort((a, b) => (RANK[a] ?? 0) - (RANK[b] ?? 0))
    const chosen = ordered.find(id => (RANK[id] ?? 0) >= target) ?? ordered[ordered.length - 1]
    effortCache.set(key, chosen)
    return chosen
  }
  return async function chat({ spec, tier, messages, system, temperature, maxTokens, signal }) {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, settings.callTimeoutMs)
    const onAbort = () => controller.abort()
    if (signal) {
      if (signal.aborted) controller.abort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    try {
      const effort = await effortFor(spec.provider, spec.model, tier)
      const options = { provider: spec.provider, model: spec.model, messages, system, temperature, maxTokens, signal: controller.signal }
      if (effort) options.reasoningEffort = effort
      let text = ''
      for await (const chunk of llm.stream(options)) {
        if (!chunk) continue
        if (chunk.type === 'text-delta') text += chunk.text ?? ''
        else if (chunk.type === 'block-end' && chunk.block?.type === 'text' && !text) text = chunk.block.text ?? ''
        else if (chunk.type === 'finish') {
          if (chunk.reason?.kind === 'error') throw new Error(chunk.reason.failure?.message ?? '模型调用失败')
          if (chunk.reason?.kind === 'aborted') throw new Error('模型调用已中止')
        }
      }
      if (!text.trim()) throw new Error('模型返回空文本')
      return text
    } catch (error) {
      if (timedOut) throw new Error(`模型调用超时（${settings.callTimeoutMs}ms）`)
      throw error
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener?.('abort', onAbort)
    }
  }
}

/** 引擎：一次 solve 对应一次 DSH Reasoning Max 3.0 请求。 */
export function createEngine({ chat, config = {}, selection, dir, logger = null }) {
  if (typeof chat !== 'function') throw new Error('createEngine 需要 chat 函数')
  const cfg = normalizeConfig(config)
  const meter = new UsageMeter()
  const arms = buildModelPool(cfg, selection)
  const router = new ModelRouter({ arms, epsilon: cfg.routerEpsilon, learn: cfg.routerLearn })
  const workDir = dir || stateDir(cfg)
  const errors = []
  const modelsUsed = {}
  let plan = null
  let budget = null
  let disposed = false

  const note = (message) => {
    if (errors.length < 60) errors.push(String(message).slice(0, 500))
    logger?.warn?.(message)
  }
  const noteModel = (role, name) => {
    modelsUsed[role] = modelsUsed[role] ?? new Set()
    modelsUsed[role].add(name)
  }
  const modelsDict = () => Object.fromEntries(Object.entries(modelsUsed).map(([role, names]) => [role, [...names].sort()]))

  async function loadRouter() {
    try {
      const parsed = JSON.parse(await readFile(join(workDir, 'router.json'), 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) router.stats = parsed
    } catch { /* 首次运行或文件损坏：从空表开始 */ }
  }
  async function saveRouter() {
    if (!cfg.routerLearn) return
    try {
      await mkdir(workDir, { recursive: true })
      const tmp = join(workDir, 'router.json.tmp')
      await writeFile(tmp, JSON.stringify(router.toJSON()), 'utf8')
      await rename(tmp, join(workDir, 'router.json'))
    } catch (error) { note(`路由状态保存失败：${error.message}`) }
  }

  function setPlan(next) {
    plan = next
    budget = new Budget(meter, next.tokenBudget, next.timeBudget)
  }

  async function call(role, messages, { purpose, spec, temperature, maxTokens, signal } = {}) {
    if (disposed) throw new Error('Reasoning Max 已结束')
    if (budget.hardExhausted()) throw new BudgetExceeded('token/时间预算已耗尽')
    if (signal?.aborted) throw new Error('请求已取消')
    const chosen = spec ?? router.pick(role, plan.tier, 1)[0]
    noteModel(role, chosen.name)
    const text = await chat({ role, spec: chosen, tier: plan.tier, messages, temperature, maxTokens, signal })
    meter.add(chosen.name, purpose ?? role, estimateTokens(text) + messages.reduce((sum, message) => sum + estimateTokens(textOf(message)), 0))
    return text
  }

  function userMessage(text) {
    return { role: 'user', content: [{ type: 'text', text }] }
  }

  async function scoreStep(question, priorSteps, step, final, signal) {
    const n = Math.max(1, plan.prmSamples)
    const specs = router.pick('prm', plan.tier, n)
    const prompt = `${PRM_SYSTEM}\n\n问题：\n${clip(question, 4000)}\n\n已有步骤：\n${clip(renderSteps(priorSteps), 6000)}\n\n最新一步：\n${clip(step, 3000)}`
    const settled = await Promise.allSettled(specs.map(spec => call('prm', [userMessage(prompt)], { purpose: 'prm', spec, temperature: 0.2, maxTokens: 300, signal })))
    const scores = []
    const verdicts = []
    const issues = []
    for (const outcome of settled) {
      if (outcome.status !== 'fulfilled') {
        if (outcome.reason instanceof BudgetExceeded) throw outcome.reason
        note(`prm: ${outcome.reason?.message ?? outcome.reason}`)
        continue
      }
      const obj = parseJsonObject(outcome.value)
      if (!obj || obj.score === undefined) continue
      scores.push(clamp01(safeFloat(obj.score, 0.5)))
      verdicts.push(String(obj.verdict ?? ''))
      if (obj.issue) issues.push(String(obj.issue).slice(0, 200))
    }
    if (!scores.length) return { score: 0.5, std: 0.5, valid: false, verdict: 'unparsed', issue: 'PRM 无有效输出' }
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length
    const std = scores.length > 1 ? Math.sqrt(scores.reduce((sum, value) => sum + (value - mean) ** 2, 0) / scores.length) : 0.1
    return { score: mean, std, valid: true, verdict: verdicts.join(','), issue: issues.join('；') }
  }

  async function candidates(question, start, count, signal) {
    if (count <= 0) return []
    const branches = BRANCHES.slice(start, start + count)
    if (!branches.length) return []
    const specs = router.pick('generator', plan.tier, branches.length)
    const settled = await Promise.allSettled(branches.map((branch, index) => {
      const [name, instruction] = branch
      const user = `分析视角：${instruction}\n\n问题：\n${question}`
      return call('generator', [userMessage(user)], { purpose: 'candidate', spec: specs[index], temperature: 0.45, signal })
        .then(content => ({ name, content, source: 'parallel', score: null, model: specs[index].name }))
    }))
    const out = []
    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') out.push(outcome.value)
      else if (outcome.reason instanceof BudgetExceeded) throw outcome.reason
      else note(`candidate: ${outcome.reason?.message ?? outcome.reason}`)
    }
    return out
  }

  function candidateText(items) {
    return items.map(item => {
      const tag = item.score === null || item.score === undefined ? '' : `（过程评分 ${item.score.toFixed(2)}，自动评审，仅供参考）`
      return `【${item.name}】${tag}\n${clip(item.content, 6000)}`
    }).join('\n\n')
  }

  async function judge(question, items, signal) {
    const armsForCritic = router.armsFor('critic')
    const nJudges = plan.tier === 'high' && new Set(armsForCritic.map(arm => arm.name)).size >= 2 ? 2 : 1
    const specs = router.pick('critic', plan.tier, nJudges)
    const prompt = `${JUDGE_SYSTEM}\n\n原问题：\n${clip(question, 6000)}\n\n候选答案：\n${candidateText(items)}`
    const settled = await Promise.allSettled(specs.map(spec => call('critic', [userMessage(prompt)], { purpose: 'judge', spec, temperature: 0.1, maxTokens: 2200, signal })))
    const judges = []
    for (const outcome of settled) {
      if (outcome.status !== 'fulfilled') {
        if (outcome.reason instanceof BudgetExceeded) throw outcome.reason
        note(`judge: ${outcome.reason?.message ?? outcome.reason}`)
        continue
      }
      judges.push(parseJsonObject(outcome.value) ?? { verdict: '需修正', issues: ['评审结果无法解析为 JSON，需人工检查。'], best_supported_conclusion: outcome.value, confidence: 0, verification_plan: [] })
    }
    return mergeJudges(judges)
  }

  async function synthesize(question, items, review, signal) {
    const system = '你是严谨的最终解答者。综合候选答案和评审意见，优先选择证据充分的结论。明确说明不确定性、争议和未实际验证的内容，不要声称执行过未执行的验证。给出结论、简洁依据、限制和可验证步骤；不要输出逐字内部思维链。'
    const candText = candidateText(items)
    const systemPrefix = `${system}\n\n`
    const spec = router.pick('synthesizer', plan.tier, 1)[0]
    let draft = ''
    for (let round = 0; round < Math.max(1, plan.refineRounds); round += 1) {
      let prompt
      if (round === 0) prompt = `${systemPrefix}问题：\n${clip(question, 6000)}\n\n候选答案：\n${candText}\n\n独立评审：\n${JSON.stringify(review)}\n\n请组织成清晰、准确、可执行的最终答复。`
      else {
        review = await judge(question, [{ name: '当前草稿', content: draft, source: 'draft', score: null }], signal)
        prompt = `${systemPrefix}问题：\n${clip(question, 6000)}\n\n当前草稿：\n${clip(draft, 8000)}\n\n针对草稿的评审：\n${JSON.stringify(review)}\n\n请给出修正后的最终答复。`
      }
      try {
        draft = await call('synthesizer', [userMessage(prompt)], { purpose: 'synth', spec, temperature: 0.2, signal }) || draft
      } catch (error) {
        if (error instanceof BudgetExceeded) throw error
        note(`synth: ${error.message}`)
        break
      }
    }
    if (draft) return { draft, review }
    const best = items.reduce((a, b) => ((b.score ?? 0) > (a.score ?? 0) ? b : a))
    return { draft: `（综合步骤失败，以下为得分最高的候选答案，未经最终综合）\n\n${best.content}`, review }
  }

  class MCTSSearch {
    async genStep(question, prior, spec, hint, force, signal) {
      const extra = force ? '\n（已达到最大推理深度：本步必须给出最终答案。）' : ''
      const prompt = `问题：\n${clip(question, 6000)}\n\n已有步骤：\n${clip(renderSteps(prior), 8000)}\n\n本步思路提示：${hint}${extra}`
      return (await call('generator', [{ role: 'user', content: [{ type: 'text', text: `${STEP_SYSTEM}\n\n${prompt}` }] }], { purpose: 'step', spec, temperature: 0.8, maxTokens: force ? 900 : 500, signal })).trim()
    }
    async expand(tree, node, question, signal) {
      const prior = tree.steps(node.id)
      const force = node.depth + 1 >= plan.maxDepth
      const k = Math.max(1, plan.branching)
      const specs = router.pick('generator', plan.tier, k)
      const settled = await Promise.allSettled(specs.map((spec, index) => this.genStep(question, prior, spec, STEP_HINTS[(node.id + index) % STEP_HINTS.length], force, signal)))
      const texts = []
      for (let index = 0; index < settled.length; index += 1) {
        const outcome = settled[index]
        if (outcome.status === 'fulfilled') texts.push([outcome.value, specs[index].name])
        else if (outcome.reason instanceof BudgetExceeded) throw outcome.reason
        else note(`generator[${specs[index].name}]: ${outcome.reason?.message ?? outcome.reason}`)
      }
      const seen = new Set(node.children.map(id => normalizeStep(tree.nodes[id].step)))
      const fresh = []
      for (const [text, model] of texts) {
        const key = normalizeStep(text)
        if (!text || seen.has(key)) continue
        seen.add(key)
        fresh.push(tree.add(node.id, text, model, FINAL_RE.test(text) || force))
      }
      node.expanded = true
      if (!fresh.length) return 0
      const scores = await Promise.allSettled(fresh.map(child => scoreStep(question, prior, child.step, child.terminal, signal)))
      for (let index = 0; index < fresh.length; index += 1) {
        const child = fresh[index]
        const outcome = scores[index]
        const score = outcome.status === 'fulfilled' ? outcome.value : { score: 0.5, std: 0.5, valid: false, verdict: 'unscored', issue: '' }
        if (outcome.status === 'rejected' && outcome.reason instanceof BudgetExceeded) throw outcome.reason
        child.prm = score.score
        child.prmStd = score.std
        child.prmValid = score.valid
        child.issue = score.issue
        child.pv = pathValue(tree.path(child.id).map(item => item.prm))
        if (child.prmValid && child.prm < cfg.pruneThreshold) child.pruned = true
        tree.backprop(child.id, child.pv)
      }
      return fresh.length
    }
    async forceFinish(tree, question, signal) {
      budget.enforce = false
      const open = tree.nodes.filter(node => node.parent !== null && !node.terminal && !node.pruned)
      const target = open.length ? open.reduce((best, node) => (node.pv > best.pv ? node : best)) : tree.nodes[0]
      const prior = tree.steps(target.id)
      const spec = router.pick('generator', plan.tier, 1)[0]
      try {
        const text = await this.genStep(question, prior, spec, '基于现有步骤直接收束，给出最终答案。', true, signal)
        if (!text) return
        const child = tree.add(target.id, text, spec.name, true)
        const score = await scoreStep(question, prior, text, true, signal)
        child.prm = score.score
        child.prmStd = score.std
        child.prmValid = score.valid
        child.issue = score.issue
        child.pv = pathValue(tree.path(child.id).map(item => item.prm))
        tree.backprop(child.id, child.pv)
      } catch (error) {
        if (error instanceof BudgetExceeded) return
        note(`force_finish: ${error.message}`)
      }
    }
    async run(question, signal) {
      const tree = new SearchTree()
      const controller = new AdaptiveController(plan, budget)
      let iterations = 0
      let reason = ''
      let failures = 0
      for (;;) {
        const check = controller.check(tree, iterations)
        if (check.stop) { reason = check.reason; break }
        iterations += 1
        const node = tree.select(cfg.uctC)
        if (!node) { reason = 'tree_exhausted'; break }
        if (node.terminal) { tree.backprop(node.id, node.pv); continue }
        let made = 0
        try { made = await this.expand(tree, node, question, signal) }
        catch (error) {
          if (error instanceof BudgetExceeded) { reason = 'budget'; break }
          note(`expand: ${error.message}`)
        }
        failures = made === 0 ? failures + 1 : 0
        if (failures >= 3) { reason = 'repeated_failures'; break }
      }
      if (!tree.terminals().length) await this.forceFinish(tree, question, signal)
      return { tree, stopReason: reason || 'done', iterations }
    }
  }

  function searchCandidates(tree, k = 3) {
    return tree.terminals().sort((a, b) => b.pv - a.pv).slice(0, k).map((node, index) => {
      const steps = tree.steps(node.id)
      const body = steps.slice(0, -1).map((step, i) => `${i + 1}. ${step}`).join('\n')
      return { name: `搜索路径${index + 1}`, content: `${body ? `推理步骤：\n${body}\n\n` : ''}${steps[steps.length - 1]}`, source: 'mcts', score: node.pv, model: node.model, nodeId: node.id }
    })
  }

  async function persist(record) {
    try { await appendJsonl(join(workDir, 'rl.jsonl'), record) }
    catch (error) { note(`RL 日志写入失败：${error.message}`) }
  }
  async function audit(record) {
    try { await appendJsonl(join(workDir, 'audit.jsonl'), { ...record, timestamp: new Date().toISOString() }) }
    catch { /* 审计失败不影响答案 */ }
  }

  async function solveFull(question, options = {}) {
    const signal = options.signal
    const text = String(question ?? '').trim()
    if (!text) throw new Error('reasoning_max 需要非空 question')
    if (text.length > cfg.maxQuestion) throw new Error(`问题过长（>${cfg.maxQuestion} 字符），请先压缩成目标与约束。`)
    await loadRouter()
    setPlan(buildPlan({ ...cfg, ...(options.mode ? { mode: options.mode } : {}) }, text, options))
    const requestId = `rmax-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
    const startedAt = Date.now()
    await audit({ requestId, event: 'start', version: RMAX_VERSION, tier: plan.tier, fastPath: plan.fastPath, pool: arms.map(arm => arm.name) })

    let items = []
    let search = null
    let review = {}
    let answer = ''
    let stopReason = ''

    if (plan.fastPath) {
      items = await candidates(text, 0, 1, signal)
      if (!items.length) throw new Error(`模型调用失败：${errors.slice(0, 3).join('；')}`)
      review = await judge(text, items, signal)
      if (review.verdict === '可接受' && safeFloat(review.confidence) >= 0.7) {
        answer = items[0].content
        stopReason = 'fast_path'
      }
      if (!answer) {
        const escalated = buildPlan(cfg, text, { ...options, tier: 'medium' })
        escalated.escalated = true
        plan = escalated
        budget = new Budget(meter, escalated.tokenBudget, escalated.timeBudget)
      }
    }

    if (!answer) {
      if (plan.useCandidates) {
        const more = await candidates(text, items.length, plan.parallelCandidates - items.length, signal)
        items = items.concat(more)
      }
      if (plan.useMcts) {
        search = await new MCTSSearch().run(text, signal)
        items = items.concat(searchCandidates(search.tree))
        stopReason = search.stopReason
      }
      if (!items.length) throw new Error(`所有推理分支均失败：${errors.slice(0, 6).join('；')}`)
      budget.enforce = false
      review = await judge(text, items, signal)
      const synth = await synthesize(text, items, review, signal)
      answer = synth.draft
      review = synth.review
      stopReason = stopReason || 'ensemble'
    }

    const tree = search?.tree ?? null
    const best = tree ? tree.bestTerminal() : null
    const reward = { value: proxyReward(review, best ? best.pv : null), source: 'proxy', weight: 0.3 }
    router.update(modelsDict(), plan.tier, reward.value, reward.weight)
    await saveRouter()
    const usage = meter.snapshot()
    const elapsed = (Date.now() - startedAt) / 1000
    await persist({
      type: 'episode', schema: 'dsh-rmax-1', version: RMAX_VERSION, timestamp: new Date().toISOString(),
      requestId, question: text, tier: plan.tier, escalated: plan.escalated, stopReason,
      answer, review, reward, modelsUsed: modelsDict(), usage,
      candidates: items.map(item => ({ name: item.name, source: item.source, score: item.score, model: item.model, nodeId: item.nodeId })),
      nodes: tree ? tree.nodes.map(node => ({ id: node.id, parent: node.parent, depth: node.depth, step: clip(node.step, 600), model: node.model, visits: node.visits, pv: node.pv, prm: node.prm, prmStd: node.prmStd, prmValid: node.prmValid, terminal: node.terminal, pruned: node.pruned })) : [],
    })
    await audit({ requestId, event: 'complete', tier: plan.tier, stopReason, escalated: plan.escalated, verdict: review.verdict, confidence: review.confidence, tokens: usage.totalTokens, calls: usage.calls, errors: errors.slice(0, 10) })
    disposed = true
    return {
      answer, requestId, tier: plan.tier, stopReason, escalated: plan.escalated,
      iterations: search?.iterations ?? 0, nodes: tree ? tree.nodes.length : 0,
      verdict: review.verdict ?? '', confidence: safeFloat(review.confidence), issues: review.issues ?? [],
      usage, elapsed, reward, modelsUsed: modelsDict(), errors,
    }
  }

  function traceOf(result) {
    return `[reasoning-max ${RMAX_VERSION}] id=${result.requestId} tier=${result.tier}${result.escalated ? '(升级)' : ''} stop=${result.stopReason} iters=${result.iterations} nodes=${result.nodes} calls=${result.usage.calls} tokens≈${result.usage.totalTokens} time=${result.elapsed.toFixed(1)}s verdict=${result.verdict} conf=${result.confidence.toFixed(2)} reward=${result.reward.value}(${result.reward.source})`
  }

  return { solveFull, traceOf, get plan() { return plan }, get errors() { return [...errors] }, router }
}

/** 从 RL 日志导出训练数据（PRM 软标签、偏好对、best-path SFT）。 */
export async function exportTraining(dir) {
  let rows = []
  try {
    const raw = await readFile(join(dir, 'rl.jsonl'), 'utf8')
    rows = raw.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
  } catch { return { episodes: 0, prmSteps: 0, preferencePairs: 0, sftBest: 0 } }
  const episodes = rows.filter(row => row.type === 'episode')
  const prmSteps = []
  const pairs = []
  const sft = []
  for (const episode of episodes) {
    for (const node of episode.nodes ?? []) {
      if (node.prmValid && node.step) prmSteps.push({ requestId: episode.requestId, nodeId: node.id, step: node.step, q: node.pv, prm: node.prm, terminal: node.terminal })
    }
    const terminal = (episode.nodes ?? []).filter(node => node.terminal)
    if (terminal.length >= 2) {
      const sorted = terminal.sort((a, b) => b.pv - a.pv)
      if (sorted[0].pv - sorted[sorted.length - 1].pv >= 0.2) pairs.push({ question: episode.question, preferred: sorted[0].step, rejected: sorted[sorted.length - 1].step, gap: sorted[0].pv - sorted[sorted.length - 1].pv })
    }
    if (episode.reward?.value >= 0.7 && episode.reward?.source !== 'proxy') sft.push({ question: episode.question, answer: episode.answer, reward: episode.reward.value })
  }
  const write = async (name, data) => {
    const lines = data.map(item => JSON.stringify(item)).join('\n')
    await writeFile(join(dir, name), lines ? `${lines}\n` : '', 'utf8')
  }
  await write('prm_steps.jsonl', prmSteps)
  await write('preference_pairs.jsonl', pairs)
  await write('sft_best.jsonl', sft)
  return { episodes: episodes.length, prmSteps: prmSteps.length, preferencePairs: pairs.length, sftBest: sft.length }
}

/** 读取路由与 RL 日志的摘要，供 /reasoning-max stats 使用。 */
export async function statsOf(dir) {
  let episodes = 0
  let settled = 0
  let rewards = 0
  let calls = 0
  try {
    const raw = await readFile(join(dir, 'rl.jsonl'), 'utf8')
    for (const line of raw.split('\n')) {
      if (!line) continue
      try {
        const row = JSON.parse(line)
        if (row.type === 'episode') {
          episodes += 1
          settled += 1
          rewards += safeFloat(row.reward?.value)
          calls += safeFloat(row.usage?.calls)
        }
      } catch { /* 跳过坏行 */ }
    }
  } catch { /* 无日志 */ }
  let router = {}
  try { router = JSON.parse(await readFile(join(dir, 'router.json'), 'utf8')) } catch { /* 无路由表 */ }
  const tables = Object.entries(router).map(([key, table]) => {
    const arms = Object.entries(table ?? {}).map(([name, value]) => ({ name, count: safeFloat(value?.[0]), mean: safeFloat(value?.[0]) ? safeFloat(value?.[1]) / safeFloat(value?.[0]) : 0 }))
    arms.sort((a, b) => b.mean - a.mean)
    return `${key}: ${arms.map(arm => `${arm.name}×${arm.count.toFixed(0)}(${arm.mean.toFixed(2)})`).join(', ')}`
  })
  return { episodes, meanReward: settled ? rewards / settled : 0, calls, tables }
}
