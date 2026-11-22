import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as rmax from '../src/reasoning-max.js'
import * as thinking from '../src/thinking.js'

const selection = { provider: 'test', model: 'm1', reasoningEffort: 'max' }
const config = { mode: 'auto', routerEpsilon: 0, callTimeoutMs: 500 }

function textOf(options) {
  return (options.messages ?? []).map(message => (typeof message.content === 'string' ? message.content
    : (message.content ?? []).filter(block => block?.type === 'text').map(block => block.text).join('\n'))).join('\n')
}

function fakeChat(handler) {
  const calls = []
  const chat = async (options) => {
    calls.push({ ...options, text: textOf(options) })
    return handler({ ...options, text: textOf(options) }, calls.length)
  }
  return { chat, calls }
}

const defaultHandler = ({ role, text }) => {
  if (role === 'prm') return JSON.stringify({ score: 0.9, verdict: 'correct', issue: '' })
  if (role === 'critic') return JSON.stringify({ verdict: '可接受', issues: [], best_supported_conclusion: '', confidence: 0.9, verification_plan: [] })
  if (role === 'synthesizer') return '综合结论：答案是 4，依据是算术定义。'
  if (text.includes('最大推理深度')) return '最终答案：结论成立，依据是已有步骤。'
  if (text.includes('步骤生成器')) return `步骤${text.length % 7 + 1}：检查一个子问题。`
  return '候选答案：4'
}

async function withEngine(fn, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rmax-test-'))
  try {
    const { chat, calls } = fakeChat(extra.handler ?? defaultHandler)
    const engine = rmax.createEngine({ chat, config: { ...config, ...extra.config }, selection, dir })
    return await fn(engine, calls, dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('难度路由与计划：简单走 low fast path，复杂升 high，mcts 模式不用候选', () => {
  assert.equal(rmax.chooseEffort('2+2 等于几').tier, 'low')
  assert.equal(rmax.chooseEffort('请证明这个定理，并做安全审计和算法推导').tier, 'high')
  assert.equal(rmax.chooseEffort('分析一下这个方案').tier, 'medium')
  const simple = rmax.buildPlan(config, '2+2 等于几')
  assert.equal(simple.tier, 'low')
  assert.equal(simple.fastPath, true)
  assert.equal(simple.useMcts, false)
  const mcts = rmax.buildPlan(config, '2+2 等于几', { mode: 'mcts' })
  assert.equal(mcts.tier, 'medium')
  assert.equal(mcts.useCandidates, false)
  const ensemble = rmax.buildPlan(config, '解释一下这个方案', { mode: 'ensemble' })
  assert.equal(ensemble.parallelCandidates, 4)
  assert.equal(ensemble.useMcts, false)
})

test('预算：搜索 80% 让位，100% 硬阻断且可关闭；路由器 UCB 记录权重', () => {
  const meter = new rmax.UsageMeter()
  const budget = new rmax.Budget(meter, 100, 0)
  meter.add('m', 'x', 85)
  assert.equal(budget.searchExhausted(), true)
  assert.equal(budget.hardExhausted(), false)
  meter.add('m', 'x', 20)
  assert.equal(budget.hardExhausted(), true)
  budget.enforce = false
  assert.equal(budget.hardExhausted(), false)

  const arms = [
    { provider: 'p', model: 'a', name: 'p/a', roles: ['generator'], costWeight: 1 },
    { provider: 'p', model: 'b', name: 'p/b', roles: ['generator'], costWeight: 1 },
  ]
  const router = new rmax.ModelRouter({ arms, epsilon: 0, rng: () => 0.5 })
  assert.deepEqual(router.pick('generator', 'high', 2).map(arm => arm.name).sort(), ['p/a', 'p/b'])
  router.update({ generator: ['p/a'] }, 'high', 1, 0.3)
  assert.equal(router.toJSON()['generator|high']['p/a'][0], 0.3)
})

test('树：select 偏向高价值子节点，剪枝节点被跳过，bestTerminal 按 pv 取优', () => {
  const tree = new rmax.SearchTree()
  const a = tree.add(0, 'a', 'm', false)
  const b = tree.add(0, 'b', 'm', true)
  tree.nodes[0].expanded = true
  tree.backprop(a.id, 0.2)
  tree.backprop(b.id, 0.9)
  const picked = tree.select(1.1)
  assert.equal(picked.id, b.id)
  tree.nodes[a.id].pruned = true
  assert.equal(tree.select(1.1).id, b.id)
  tree.nodes[b.id].pv = 0.9
  assert.equal(tree.bestTerminal().id, b.id)
})

test('fast path：只调 1 个候选 + 1 个评审，达到置信阈值就直接交答案', async () => {
  await withEngine(async (engine, calls) => {
    const result = await engine.solveFull('2+2 等于几')
    assert.equal(result.tier, 'low')
    assert.equal(result.stopReason, 'fast_path')
    assert.equal(result.answer, '候选答案：4')
    assert.equal(calls.length, 2)
    assert.deepEqual(calls.map(call => call.role), ['generator', 'critic'])
    assert.match(engine.traceOf(result), /tier=low/)
  })
})

test('fast path 评审不通过时升级到 medium，并行候选 + 评审 + 综合', async () => {
  const handler = (options, n) => {
    if (options.role === 'critic') return JSON.stringify({ verdict: '需修正', issues: ['验证不足'], best_supported_conclusion: '4', confidence: 0.4, verification_plan: [] })
    if (options.role === 'synthesizer') return '修正后的综合结论。'
    if (options.role === 'prm') return JSON.stringify({ score: 0.8, verdict: 'correct', issue: '' })
    return `候选${n}`
  }
  await withEngine(async (engine, calls) => {
    const result = await engine.solveFull('2+2 等于几')
    assert.equal(result.escalated, true)
    assert.equal(result.tier, 'medium')
    assert.equal(result.answer, '修正后的综合结论。')
    assert.ok(calls.filter(call => call.role === 'generator').length >= 2)
    assert.ok(calls.some(call => call.role === 'synthesizer'))
  }, { handler })
})

test('ensemble 模式不使用树搜索：4 个候选 + 1 次评审 + 综合', async () => {
  await withEngine(async (engine, calls) => {
    const result = await engine.solveFull('解释一下这个方案', { mode: 'ensemble' })
    assert.equal(result.answer, '综合结论：答案是 4，依据是算术定义。')
    assert.equal(calls.filter(call => call.role === 'generator').length, 4)
    assert.equal(calls.filter(call => call.role === 'critic').length, 1)
    assert.equal(calls.filter(call => call.role === 'synthesizer').length, 1)
  })
})

test('mcts 模式能扩展步骤、打分、收束，并写 RL 日志与路由表', async () => {
  await withEngine(async (engine, calls, dir) => {
    const result = await engine.solveFull('请证明这个定理，并做安全算法推导', { mode: 'mcts', iterations: 2 })
    assert.ok(['planned', 'planned_limit', 'confident', 'plateau', 'budget'].includes(result.stopReason), result.stopReason)
    assert.ok(result.answer.includes('综合结论'))
    assert.ok(result.iterations >= 1)
    assert.ok(calls.some(call => call.role === 'prm'))
    const rl = await readFile(join(dir, 'rl.jsonl'), 'utf8')
    assert.match(rl, /"type":"episode"/)
    const router = JSON.parse(await readFile(join(dir, 'router.json'), 'utf8'))
    assert.ok(Object.keys(router).length > 0)
    const stats = await rmax.statsOf(dir)
    assert.equal(stats.episodes, 1)
    const exported = await rmax.exportTraining(dir)
    assert.equal(exported.episodes, 1)
    assert.ok(exported.prmSteps >= 1)
  }, { handler: defaultHandler, config: { maxRefine: 0 } })
})

test('全部候选失败时抛出带错误的失败信息，不伪造答案', async () => {
  const handler = () => { throw new Error('provider down') }
  await withEngine(async engine => {
    await assert.rejects(engine.solveFull('2+2 等于几'), /所有推理分支均失败|provider down/)
  }, { handler })
})

test('PRM/评审输出不可解析时不假装通过，给出保守评审', async () => {
  const handler = ({ role }) => {
    if (role === 'critic') return '无法解析的自由文本'
    if (role === 'synthesizer') return '保守结论。'
    return '候选答案'
  }
  await withEngine(async engine => {
    const result = await engine.solveFull('解释一下这个方案', { mode: 'ensemble' })
    assert.equal(result.verdict, '需修正')
    assert.equal(result.answer, '保守结论。')
  }, { handler })
})

test('createLlmChat：按档位声明选 effort，拼接 text-delta；finish error 会抛错', async () => {
  const seen = []
  const llm = {
    async resolveModelInfo() { return { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }, { id: 'max' }] } } },
    async *stream(options) {
      seen.push(options)
      yield { type: 'text-delta', index: 0, text: '答' }
      yield { type: 'text-delta', index: 0, text: '案' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const chat = rmax.createLlmChat(llm, selection, { callTimeoutMs: 1000 })
  const spec = { provider: 'test', model: 'm1', name: 'test/m1' }
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
  assert.equal(await chat({ spec, tier: 'high', messages }), '答案')
  assert.equal(seen[0].reasoningEffort, 'max')
  await chat({ spec, tier: 'low', messages })
  assert.equal(seen[1].reasoningEffort, 'low')
  const failing = rmax.createLlmChat({
    async resolveModelInfo() { return {} },
    async *stream() { yield { type: 'finish', reason: { kind: 'error', failure: { message: 'boom' } } } },
  }, selection, { callTimeoutMs: 1000 })
  await assert.rejects(failing({ spec, tier: 'low', messages }), /boom/)
})

test('thinking.apply 注册 reasoning_max 工具与命令，执行后走真实引擎，卸载时清理', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rmax-wire-'))
  const tools = new Map()
  const commands = new Map()
  const disposers = []
  const llm = {
    async resolveModelInfo() { return { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }, { id: 'max' }] } } },
    async *stream(options) {
      const text = textOf(options)
      if (text.includes('答案评审器')) {
        yield { type: 'text-delta', index: 0, text: JSON.stringify({ verdict: '可接受', issues: [], best_supported_conclusion: '4', confidence: 0.9, verification_plan: [] }) }
      } else {
        yield { type: 'text-delta', index: 0, text: '候选答案：4' }
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const ctx = {
    logger: { warn() {} },
    llm,
    effect(fn) { const disposer = fn(); if (typeof disposer === 'function') disposers.push(disposer); return disposer },
    on() { return () => {} },
    tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
    commands: { register(definition) { commands.set(definition.name, definition); return () => commands.delete(definition.name) } },
    skills: { register() { return () => {} } },
    sessionProjections: { async register() { return { stateOf: () => thinking.initialState() } } },
    agents: { list: () => [] },
  }
  try {
    await thinking.apply(ctx, { enabled: true, mode: 'auto', reasoningMax: { enabled: true, stateDir: dir, routerEpsilon: 0 } })
    assert.ok(tools.has('reasoning_max'))
    assert.ok(tools.has('pro_focus'))
    assert.ok(commands.has('reasoning-max'))
    const agent = { model: { current: () => ({ provider: 'test', model: 'm1', reasoningEffort: 'max' }) } }
    const value = await tools.get('reasoning_max').execute({ question: '2+2 等于几' }, { agent, signal: new AbortController().signal })
    assert.match(value.answer, /4/)
    assert.match(value.trace, /tier=low/)
    for (const dispose of disposers.reverse()) dispose()
    assert.equal(tools.has('reasoning_max'), false)
    assert.equal(commands.has('reasoning-max'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('评审合并取最严结论、平均置信度并去重问题；奖励按结论与置信度计算', () => {
  const merged = rmax.mergeJudges([
    { verdict: '可接受', issues: ['a'], confidence: 0.9, best_supported_conclusion: 'x' },
    { verdict: '信息不足', issues: ['a', 'b'], confidence: 0.5, best_supported_conclusion: 'y' },
  ])
  assert.equal(merged.verdict, '信息不足')
  assert.deepEqual(merged.issues, ['a', 'b'])
  assert.ok(Math.abs(merged.confidence - 0.7) < 1e-9)
  assert.ok(rmax.proxyReward({ verdict: '可接受', confidence: 1 }, 1) > 0.9)
  assert.ok(rmax.proxyReward({ verdict: '信息不足', confidence: 0.2 }, null) < 0.3)
  assert.ok(Math.abs(rmax.pathValue([0.9, 0.4, 0.8]) - 0.6) < 1e-9)
})
