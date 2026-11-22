import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, evaluate, DEFAULTS } from '../src/escalator.js'
import { createFakeCtx, createFakeAgent, createToolExec, OK_RESULT, failResult } from './fake-ctx.mjs'

/**
 * 走一遍 pre-step，把 step/turn 推进到位。
 * 0.2.2-rc.3 的 payload 带 modelSelection（本步固定选择）。
 */
async function step(ctx, agent, { turn = 1, step: stepNumber = 1, messages = [], modelSelection } = {}) {
  await ctx.call('agent/pre-step', [{
    agent,
    turn,
    step: stepNumber,
    messages,
    signal: new AbortController().signal,
    modelSelection: modelSelection ?? agent.model?.current(),
  }], { kind: 'enter', messages: [] })
}

/** 走一遍 post-execute，返回注入的消息（如有）。 */
async function toolCall(ctx, agent, { name = 'bash', args = {}, result = OK_RESULT } = {}) {
  const decision = await ctx.call('tools/post-execute', [createToolExec({ name, args, agent }), result], { kind: 'accept' })
  return decision?.additionalContexts?.[0]
}

test('重复调用达到阈值后注入提醒', async () => {
  const { ctx, call } = createFakeCtx()
  apply(ctx, { language: 'zh', repeatThreshold: 3, cooldownSteps: 1 })

  const agent = createFakeAgent()
  await step(ctx, agent, { step: 1 })

  const args = { command: 'npm test' }
  await toolCall(ctx, agent, { args })
  await toolCall(ctx, agent, { args })
  await step(ctx, agent, { step: 2 })
  // 第三次相同调用触发干预
  const message = await toolCall(ctx, agent, { args })

  assert.ok(message, '应当注入一条提醒')
  assert.equal(message.source.kind, 'v41pro-escalator')
  assert.equal(message.source.form, 'notice')
  assert.match(message.content[0].text, /重复调用/)
  // 必须声明这不是用户说的话
  assert.match(message.content[0].text, /不是用户/)
  assert.ok(call, 'ctx.call 可用')
})

test('连续失败也会触发', async () => {
  const { ctx } = createFakeCtx()
  apply(ctx, { language: 'zh', failureThreshold: 2, cooldownSteps: 0, threshold: 3 })

  const agent = createFakeAgent()
  await step(ctx, agent, { step: 1 })
  await toolCall(ctx, agent, { name: 'bash', args: { command: 'a' }, result: failResult('x') })
  await toolCall(ctx, agent, { name: 'bash', args: { command: 'b' }, result: failResult('y') })
  const message = await toolCall(ctx, agent, { name: 'bash', args: { command: 'c' }, result: failResult('z') })

  assert.ok(message)
  assert.match(message.content[0].text, /连续失败/)
})

test('escalate 模式下第二次干预写入 pro 模型选择（agent.model.select）', async () => {
  const llm = {
    async resolveModelInfo(provider, model) {
      return { id: model, provider, reasoning: { efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }], defaultEffort: 'high' } }
    },
  }
  const fake = createFakeCtx({ llm })
  apply(fake.ctx, {
    mode: 'escalate',
    proModel: 'deepseek-v4-pro',
    proReasoningEffort: 'high',
    repeatThreshold: 3,
    cooldownSteps: 1,
    escalateSteps: 4,
    language: 'zh',
  })

  const agent = createFakeAgent('s-1', { provider: 'deepseek-official', model: 'deepseek-flash' })

  await step(fake.ctx, agent, { step: 1 })
  const args = { command: 'npm test' }
  await toolCall(fake.ctx, agent, { args })
  await toolCall(fake.ctx, agent, { args })
  const first = await toolCall(fake.ctx, agent, { args })
  assert.match(first.content[0].text, /你可能已经卡住了/)
  assert.equal(agent.selections.length, 0, '第一次干预只提醒，不换模型')

  // 冷却之后同一重复链再次触发 → 第二次干预 = 升级
  await step(fake.ctx, agent, { step: 2 })
  const second = await toolCall(fake.ctx, agent, { args })
  assert.match(second.content[0].text, /升级/)

  assert.equal(agent.selections.length, 1, '必须通过公开的 agent.model.select 换模型')
  assert.deepEqual(agent.selections[0], {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    reasoningEffort: 'high',
  })
})

test('escalateSteps 用尽后自动降回原模型', async () => {
  const llm = {
    async resolveModelInfo(provider, model) {
      return { id: model, provider, reasoning: { efforts: [{ id: 'high' }] } }
    },
  }
  const fake = createFakeCtx({ llm })
  apply(fake.ctx, {
    mode: 'escalate',
    proModel: 'deepseek-v4-pro',
    repeatThreshold: 3,
    cooldownSteps: 1,
    escalateSteps: 2,
  })

  const agent = createFakeAgent('s-2', { provider: 'deepseek-official', model: 'deepseek-flash' })
  await step(fake.ctx, agent, { step: 1 })
  const args = { command: 'same' }
  await toolCall(fake.ctx, agent, { args })
  await toolCall(fake.ctx, agent, { args })
  await toolCall(fake.ctx, agent, { args })
  await step(fake.ctx, agent, { step: 2 })
  await toolCall(fake.ctx, agent, { args })

  assert.equal(agent.selections.length, 1)
  assert.equal(agent.selections[0].model, 'deepseek-v4-pro')

  // 第 2 步升级，窗口到第 4 步；第 3 步仍用 pro，第 4 步的 pre-step 写回原选择。
  await step(fake.ctx, agent, { step: 3 })
  assert.equal(agent.selections.length, 1, '窗口内不回退')
  await step(fake.ctx, agent, { step: 4 })
  assert.equal(agent.selections.length, 2, '窗口结束必须写回原选择')
  assert.equal(agent.selections[1].model, 'deepseek-flash')
})

test('升级期间用户手动换模型时不覆盖用户选择', async () => {
  const llm = { async resolveModelInfo(provider, model) { return { id: model, provider } } }
  const fake = createFakeCtx({ llm })
  apply(fake.ctx, { mode: 'escalate', proModel: 'deepseek-v4-pro', repeatThreshold: 3, cooldownSteps: 1, escalateSteps: 2 })

  const agent = createFakeAgent('s-3', { provider: 'deepseek-official', model: 'deepseek-flash' })
  await step(fake.ctx, agent, { step: 1 })
  const args = { command: 'x' }
  await toolCall(fake.ctx, agent, { args })
  await toolCall(fake.ctx, agent, { args })
  await toolCall(fake.ctx, agent, { args })
  await step(fake.ctx, agent, { step: 2 })
  await toolCall(fake.ctx, agent, { args })
  assert.equal(agent.selections.length, 1)

  // 用户中途自己换了模型
  agent.model.select({ provider: 'deepseek-official', model: 'deepseek-v4-pro-manual' })
  const before = agent.selections.length

  await step(fake.ctx, agent, { step: 4 })
  assert.equal(agent.selections.length, before, '不能覆盖用户手动选择')
})

test('advise 模式永远不改模型', async () => {
  const { ctx } = createFakeCtx()
  apply(ctx, { mode: 'advise', repeatThreshold: 3, cooldownSteps: 0 })

  const agent = createFakeAgent()
  await step(ctx, agent, { step: 1 })
  const args = { command: 'x' }
  for (let index = 0; index < 8; index += 1) await toolCall(ctx, agent, { args })

  assert.equal(agent.selections.length, 0)
})

test('provider 不认识 proModel 时自动关闭升级', async () => {
  const llm = {
    async resolveModelInfo(provider, model) {
      if (model === 'deepseek-v4-pro') throw new Error('unknown model')
      return { id: model, provider }
    },
  }
  const fake = createFakeCtx({ llm })
  apply(fake.ctx, { mode: 'escalate', proModel: 'deepseek-v4-pro', repeatThreshold: 3, cooldownSteps: 0 })

  const agent = createFakeAgent('s-4', { provider: 'some-provider', model: 'deepseek-flash' })
  await step(fake.ctx, agent, { step: 1 })
  const args = { command: 'x' }
  for (let index = 0; index < 8; index += 1) await toolCall(fake.ctx, agent, { args })

  assert.equal(agent.selections.length, 0, '探测失败时不能换模型')
})

test('目标模型只支持 off 时不会写死 high（否则请求会被 reject）', async () => {
  const llm = {
    async resolveModelInfo(provider, model) {
      return { id: model, provider, reasoning: { efforts: [{ id: 'off' }], defaultEffort: 'off' } }
    },
  }
  const fake = createFakeCtx({ llm })
  apply(fake.ctx, {
    mode: 'escalate',
    proModel: 'deepseek-v4-pro',
    proReasoningEffort: 'high',
    repeatThreshold: 3,
    cooldownSteps: 1,
  })

  const agent = createFakeAgent('s-5', { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' })
  await step(fake.ctx, agent, { step: 1 })
  const args = { command: 'x' }
  await toolCall(fake.ctx, agent, { args })
  await toolCall(fake.ctx, agent, { args })
  await toolCall(fake.ctx, agent, { args })
  await step(fake.ctx, agent, { step: 2 })
  await toolCall(fake.ctx, agent, { args })

  assert.equal(agent.selections.length, 1)
  assert.equal(agent.selections[0].model, 'deepseek-v4-pro')
  assert.equal('reasoningEffort' in agent.selections[0], false, '不可用的档位必须删掉，交给适配器取默认值')
})

test('目标模型支持 high 时按配置升级档位', async () => {
  const llm = {
    async resolveModelInfo(provider, model) {
      return { id: model, provider, reasoning: { efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }], defaultEffort: 'high' } }
    },
  }
  const fake = createFakeCtx({ llm })
  apply(fake.ctx, {
    mode: 'escalate', proModel: 'deepseek-v4-pro', proReasoningEffort: 'high',
    repeatThreshold: 3, cooldownSteps: 1,
  })

  const agent = createFakeAgent('s-6', { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' })
  await step(fake.ctx, agent, { step: 1 })
  const args = { command: 'x' }
  await toolCall(fake.ctx, agent, { args })
  await toolCall(fake.ctx, agent, { args })
  await toolCall(fake.ctx, agent, { args })
  await step(fake.ctx, agent, { step: 2 })
  await toolCall(fake.ctx, agent, { args })

  assert.equal(agent.selections[0].reasoningEffort, 'high')
})

test('没有 agent.model 的旧 harness 上只提醒，不假装升级', async () => {
  const llm = { async resolveModelInfo(provider, model) { return { id: model, provider } } }
  const fake = createFakeCtx({ llm })
  apply(fake.ctx, { mode: 'escalate', proModel: 'deepseek-v4-pro', repeatThreshold: 2, cooldownSteps: 0, threshold: 3 })

  const agent = createFakeAgent('s-7')
  delete agent.model
  await step(fake.ctx, agent, { step: 1 })
  const args = { command: 'x' }
  await toolCall(fake.ctx, agent, { args })
  await toolCall(fake.ctx, agent, { args })
  const message = await toolCall(fake.ctx, agent, { args })

  assert.ok(message)
  assert.match(message.content[0].text, /仍然卡住/)
})

test('用户插话会重置重复链', async () => {
  const { ctx } = createFakeCtx()
  apply(ctx, { repeatThreshold: 2, cooldownSteps: 0, threshold: 3 })

  const agent = createFakeAgent()
  const args = { command: 'x' }
  await step(ctx, agent, { step: 1 })
  await toolCall(ctx, agent, { args })

  // 用户新消息
  await step(ctx, agent, {
    step: 2,
    messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: '换个思路' }] }],
  })
  const message = await toolCall(ctx, agent, { args })
  assert.equal(message, undefined, '用户插话之后同样的调用不应算作重复')
})

test('相同失败跨成功读取复发时仍能识别', async () => {
  const { ctx } = createFakeCtx()
  apply(ctx, { repeatThreshold: 3, cooldownSteps: 0, language: 'zh' })
  const agent = createFakeAgent()
  await step(ctx, agent, { step: 1 })
  const args = { command: 'pnpm test' }
  await toolCall(ctx, agent, { args, result: failResult('1 failing') })
  await toolCall(ctx, agent, { name: 'read', args: { path: 'a.js' } })
  await toolCall(ctx, agent, { args, result: failResult('1 failing') })
  await toolCall(ctx, agent, { name: 'read', args: { path: 'b.js' } })
  const message = await toolCall(ctx, agent, { args, result: failResult('1 failing') })
  assert.ok(message)
  assert.match(message.content[0].text, /重复失败/)
})

test('相同测试以非零退出标记返回时也算重复失败', async () => {
  const { ctx } = createFakeCtx()
  apply(ctx, { repeatThreshold: 3, cooldownSteps: 0, language: 'zh' })
  const agent = createFakeAgent()
  await step(ctx, agent, { step: 1 })
  const args = { command: 'pnpm test' }
  const result = { isError: false, content: [{ type: 'text', text: '2 failing\n[exit code: 1]' }] }
  await toolCall(ctx, agent, { args, result })
  await toolCall(ctx, agent, { args, result })
  const message = await toolCall(ctx, agent, { args, result })
  assert.ok(message)
  assert.match(message.content[0].text, /重复失败/)
})

test('升级窗口内再次干预不会覆盖原始回退模型', async () => {
  const llm = { async resolveModelInfo(provider, model) { return { id: model, provider, reasoning: { efforts: [{ id: 'high' }] } } } }
  const { ctx } = createFakeCtx({ llm })
  apply(ctx, { mode: 'escalate', proModel: 'deepseek-v4-pro', repeatThreshold: 3, cooldownSteps: 3, escalateSteps: 4 })
  const agent = createFakeAgent()
  await step(ctx, agent, { step: 1 })
  const args = { command: 'same' }
  for (let index = 0; index < 3; index += 1) await toolCall(ctx, agent, { args })
  await step(ctx, agent, { step: 4 })
  await toolCall(ctx, agent, { args })
  assert.equal(agent.currentSelection.model, 'deepseek-v4-pro')
  await step(ctx, agent, { step: 7 })
  await toolCall(ctx, agent, { args })
  await step(ctx, agent, { step: 8 })
  assert.equal(agent.currentSelection.model, 'deepseek-flash')
  assert.equal(agent.selections.filter(selection => selection.model === 'deepseek-v4-pro').length, 1)
})

test('模型选择被拒绝时退回提醒且不抛出', async () => {
  const llm = { async resolveModelInfo(provider, model) { return { id: model, provider } } }
  const { ctx } = createFakeCtx({ llm })
  apply(ctx, { mode: 'escalate', proModel: 'deepseek-v4-pro', repeatThreshold: 2, cooldownSteps: 0 })
  const agent = createFakeAgent()
  const original = agent.model.select
  agent.model.select = selection => {
    if (selection.model === 'deepseek-v4-pro') throw new Error('provider rejected')
    original(selection)
  }
  await step(ctx, agent, { step: 1 })
  await toolCall(ctx, agent, { args: { command: 'x' } })
  await toolCall(ctx, agent, { args: { command: 'x' } })
  await step(ctx, agent, { step: 2 })
  const message = await toolCall(ctx, agent, { args: { command: 'x' } })
  assert.match(message.content[0].text, /仍然卡住/)
  assert.equal(agent.currentSelection.model, 'deepseek-flash')
})

test('evaluate 对弱信号单独不触发', () => {
  const state = {
    repeat: 0, consecutiveFailures: 0, selfDoubt: false,
    edits: new Map([['a.js', 3]]), step: 10, lastProgressStep: 5, lastTool: 'edit',
  }
  const signals = evaluate(state, { ...DEFAULTS, editRepeatThreshold: 4, noProgressSteps: 8, repeatThreshold: 4, failureThreshold: 3 })
  assert.equal(signals.length, 0, '单个弱信号不构成卡住')
})

test('监听器抛错不会逃逸', async () => {
  const { ctx } = createFakeCtx()
  apply(ctx, {})
  const agent = createFakeAgent()
  // 传一个畸形的 exec，插件内部必须自行吞掉异常
  await assert.doesNotReject(
    ctx.call('tools/post-execute', [{ name: 'bash', arguments: undefined, agent }, OK_RESULT], { kind: 'accept' }),
  )
})

test('会话销毁后状态被清理', async () => {
  const { ctx, emit } = createFakeCtx()
  apply(ctx, {})
  const agent = createFakeAgent('s-1')
  await step(ctx, agent, { step: 1 })
  emit('agent/disposed', { agent })
  // 再次使用应当重新建状态，不报错
  await step(ctx, agent, { step: 1 })
})
