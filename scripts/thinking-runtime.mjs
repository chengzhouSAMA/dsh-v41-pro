import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import * as thinking from '../src/thinking.js'

const require = createRequire(join(process.env.DSH_INSTALL_DIR, 'package.json'))
const load = async name => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href)
const { Context } = await load('cordis')
const root = new Context()
const errors = []
root.on('agent/error', ({ error }) => { errors.push(error); console.error('AGENT ERROR', error.message) })
try {
  for (const name of ['dsh-session', 'dsh-session-projection', 'dsh-llm', 'dsh-agent', 'dsh-tools', 'dsh-system-prompt', 'dsh-tool-executor-native', 'dsh-commands', 'dsh-skill', 'dsh-agent-loop']) {
    const mod = await load(name)
    await root.plugin(mod.default ?? mod)
  }
  const { LlmAdapter, createUserMessage } = await load('dsh-llm')
  const calls = []
  let planNext = false
  let verifyNext = false
  root.tools.register({ name: 'fixture_probe', description: '无副作用的测试工具',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { return '验证证据已取得' } })
  class FixtureAdapter extends LlmAdapter {
    providerInfo(provider) { return { id: provider, name: provider } }
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 100000 }, reasoning: { efforts: (model === 'no-max' ? ['off', 'low', 'high', 'xhigh'] : ['off', 'low', 'high', 'max']).map(id => ({ id, name: id })), defaultEffort: 'off' } } }
    async *stream(options) {
      calls.push(options)
      if (planNext || verifyNext) {
        const toolName = verifyNext ? 'fixture_probe' : 'pro_focus'
        planNext = false
        verifyNext = false
        const block = { type: 'tool-call', id: `focus-${calls.length}`, name: toolName, arguments: '{}' }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: '{}' }
        yield { type: 'block-end', index: 0, block }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: '测试响应' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '测试响应' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  root.llm.registerAdapter(['fixture'], new FixtureAdapter())
  const fiber = await root.plugin(thinking)
  const handle = await root.agents.create({ sessionId: 'thinking-runtime-test', agentOptions: { provider: 'fixture', model: 'fixture-model', reasoningEffort: 'off' } })
  const agent = handle.agent
  const user = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  const command = text => root.commands.execute(agent, `/thinking ${text}`, [], new AbortController().signal)
  const run = async text => { calls.length = 0; agent.followup(user(text)); await agent.whenIdle() }

  await run('1+1等于几？只要答案。')
  assert.deepEqual(calls.map(c => c.reasoningEffort), ['low'], '简单问题不得强制额外聚焦请求')
  const prompt = user('设计一个具有多项约束的方案，分析方案再实现并验证。')
  calls.length = 0
  planNext = true
  agent.followup(prompt)
  await agent.whenIdle()
  assert.deepEqual(calls.map(c => c.reasoningEffort), ['low', 'high'])
  assert.ok(calls.every(c => Object.isFrozen(c)))
  assert.ok(calls.every(c => c.messages.filter(m => m.id === prompt.id).length === 1))
  assert.ok(calls[0].tools.some(t => t.name === 'pro_focus'), '模型必须能调用真实聚焦转换工具')
  assert.ok(calls[1].messages.some(m => m.role === 'tool' && m.toolCallId === 'focus-1' && !m.isError))
  assert.ok(calls[0].messages.some(m => m.source?.kind === thinking.name && m.content[0].text.includes('发散')))
  assert.ok(calls[1].messages.some(m => m.source?.kind === thinking.name && m.content[0].text.includes('聚焦')))
  const focusedSeed = agent.session.snapshotEvents()

  assert.equal((await command('focused')).result.kind, 'success')
  await run('继续')
  assert.deepEqual(calls.map(c => c.reasoningEffort), ['high'])
  assert.equal((await command('thorough')).result.kind, 'success')
  assert.match((await command('status')).result.text, /透彻.*仅限 max/)
  const deepPrompt = user('定位根因，调用验证工具，再交叉检查结论。')
  calls.length = 0
  verifyNext = true
  agent.followup(deepPrompt)
  await agent.whenIdle()
  assert.deepEqual(calls.map(c => c.reasoningEffort), ['max', 'max'], '首请求和工具后的后续请求只能 max')
  assert.ok(calls.every(c => Object.isFrozen(c) && c.messages.filter(m => m.id === deepPrompt.id).length === 1))
  assert.ok(calls.every(c => !c.tools.some(t => t.name === 'pro_focus')), '透彻不暴露自动聚焦工具')
  assert.ok(calls[0].messages.some(m => m.source?.kind === thinking.name && m.content[0].text.includes('根因') && m.content[0].text.includes('仅限 max')))
  assert.equal(root.sessionProjections.snapshot(agent.session).values.v41proThinking.phase, 'thorough')
  const thoroughSeed = agent.session.snapshotEvents()
  await run('继续')
  assert.deepEqual(calls.map(c => c.reasoningEffort), ['max'])
  await run('另一项全新的任务')
  assert.deepEqual(calls.map(c => c.reasoningEffort), ['max'])
  assert.equal((await command('focused')).result.kind, 'success')
  await run('继续')
  assert.deepEqual(calls.map(c => c.reasoningEffort), ['high'], '离开透彻后按原始基线恢复聚焦下限')
  assert.equal((await command('off')).result.kind, 'success')
  assert.equal(agent.model.current().reasoningEffort, 'off')
  assert.equal(root.sessionProjections.snapshot(agent.session).values.v41proThinking.mode, 'off')
  agent.model.select({ provider: 'fixture', model: 'fixture-model', reasoningEffort: 'high' })
  await run('关闭后保留我手动选择的high')
  assert.deepEqual(calls.map(c => c.reasoningEffort), ['high'])
  assert.equal(agent.model.current().reasoningEffort, 'high', '关闭后不得再次恢复旧档位')
  await handle.dispose()

  const unsupported = await root.agents.create({ sessionId: 'thinking-no-max',
    agentOptions: { provider: 'fixture', model: 'no-max', reasoningEffort: 'high' } })
  const rejectedMode = await root.commands.execute(unsupported.agent, '/thinking thorough', [], new AbortController().signal)
  assert.equal(rejectedMode.result.kind, 'error')
  assert.match(rejectedMode.result.text, /max/)
  assert.equal(root.sessionProjections.snapshot(unsupported.agent.session).values.v41proThinking.mode, 'auto')
  unsupported.agent.model.select({ provider: 'fixture', model: 'fixture-model', reasoningEffort: 'high' })
  assert.equal((await root.commands.execute(unsupported.agent, '/thinking thorough', [], new AbortController().signal)).result.kind, 'success')
  unsupported.agent.model.select({ provider: 'fixture', model: 'no-max', reasoningEffort: 'high' })
  const pendingInput = user('切到不支持max的模型后，原始任务仍须保留。')
  calls.length = 0
  const errorCount = errors.length
  unsupported.agent.followup(pendingInput)
  await unsupported.agent.whenIdle()
  assert.equal(calls.length, 0, '不支持 max 时不能发送任何降档请求')
  assert.equal(errors.length, errorCount + 1)
  assert.match(errors.at(-1).message, /max/)
  unsupported.agent.model.select({ provider: 'fixture', model: 'fixture-model', reasoningEffort: 'high' })
  unsupported.agent.followup(user('继续'))
  await unsupported.agent.whenIdle()
  assert.deepEqual(calls.map(c => c.reasoningEffort), ['max'])
  assert.equal(calls[0].messages.filter(m => m.id === pendingInput.id).length, 1, '拒绝后的原始输入必须保留且不重复')
  await unsupported.dispose()

  const thoroughRestored = await root.agents.create({ sessionId: 'thinking-thorough-restored', seed: thoroughSeed,
    agentOptions: { provider: 'fixture', model: 'fixture-model', reasoningEffort: 'max' } })
  assert.equal(root.sessionProjections.snapshot(thoroughRestored.agent.session).values.v41proThinking.phase, 'thorough')
  calls.length = 0
  thoroughRestored.agent.followup(user('继续'))
  await thoroughRestored.agent.whenIdle()
  assert.deepEqual(calls.map(c => c.reasoningEffort), ['max'], '恢复后的透彻模式仍严格使用 max')

  // Seed 模拟恢复会话：还没有新请求时卸载也必须恢复此前模块拥有的档位。
  const restored = await root.agents.create({ sessionId: 'thinking-runtime-restored', seed: focusedSeed,
    agentOptions: { provider: 'fixture', model: 'fixture-model', reasoningEffort: 'high' } })
  assert.equal(root.sessionProjections.snapshot(restored.agent.session).values.v41proThinking.mode, 'auto')
  assert.ok(await root.skills.get('diverge-focus-reasoning'))
  assert.ok(await root.skills.get('best-effort-agent'))
  const bundle = await import('../index.js')
  const clientOnly = await root.plugin(bundle, { clientOnly: true })
  await clientOnly.dispose()
  assert.ok(await root.skills.get('best-effort-agent'), '客户端空入口不得影响独立思考模块')
  await fiber.dispose()
  assert.equal(restored.agent.model.current().reasoningEffort, 'off', '恢复会话未发请求就卸载也应还原')
  assert.equal(thoroughRestored.agent.model.current().reasoningEffort, 'off', '透彻模式卸载恢复原始基线')
  await thoroughRestored.dispose()
  assert.equal(await root.skills.get('diverge-focus-reasoning'), undefined)
  assert.equal(await root.skills.get('best-effort-agent'), undefined)
  assert.equal(root.tools.get('pro_focus'), undefined)
  restored.agent.model.select({ provider: 'fixture', model: 'fixture-model', reasoningEffort: 'high' })
  const remounted = await root.plugin(thinking)
  const offAfterReload = await root.commands.execute(restored.agent, '/thinking off', [], new AbortController().signal)
  assert.equal(offAfterReload.result.kind, 'success')
  assert.equal(restored.agent.model.current().reasoningEffort, 'high', '重挂不得恢复已经撤销的旧所有权')
  await restored.dispose()

  async function verifyRace(action) {
    calls.length = 0
    const live = await root.agents.create({ sessionId: `thinking-race-${action}`,
      agentOptions: { provider: 'fixture', model: 'fixture-model', reasoningEffort: 'off' } })
    const entered = Promise.withResolvers(), release = Promise.withResolvers()
    let hold = false
    const llm = root.llm, resolve = llm.resolveModelInfo.bind(llm)
    llm.resolveModelInfo = async (...args) => {
      if (hold) { hold = false; entered.resolve(); await release.promise }
      return resolve(...args)
    }
    const unhook = root.on('agent/pre-step', async (_payload, next) => { hold = true; return next() })
    const message = user('等待能力查询时关闭思考模块')
    try {
      live.agent.followup(message)
      await entered.promise
      if (action === 'off') {
        const result = await root.commands.execute(live.agent, '/thinking off', [], new AbortController().signal)
        assert.equal(result.result.kind, 'success')
      } else await remounted.dispose()
      release.resolve()
      await live.agent.whenIdle()
      assert.equal(live.agent.model.current().reasoningEffort, 'off', `${action}竞态不得重新提档`)
      assert.deepEqual(calls.map(c => c.reasoningEffort), ['off'])
      assert.equal(calls[0].messages.filter(m => m.id === message.id).length, 1)
    } finally {
      release.resolve()
      unhook()
      llm.resolveModelInfo = resolve
      await live.dispose()
    }
  }
  await verifyRace('off')
  await verifyRace('unload')
  assert.equal(errors.length, 1, '仅允许预期的不支持 max 错误')
  console.log('PASS: DSH rc.5 real loop: thorough max→max, no-max rejection/input preserved, restore/continue/new-task max, simple one-call, auto low→high, manual choice, unload/remount, async off/unload races, skill/tool disposal')
} finally {
  await root.fiber.dispose()
}
