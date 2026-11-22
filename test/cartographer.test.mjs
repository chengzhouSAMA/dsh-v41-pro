import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../src/cartographer.js'
import { createFakeCtx, createFakeAgent, createToolExec, OK_RESULT } from './fake-ctx.mjs'

async function preStep(ctx, agent, { turn = 1, step = 1, messages = [] } = {}) {
  return ctx.call(
    'agent/pre-step',
    [{ agent, turn, step, messages, signal: new AbortController().signal }],
    { kind: 'enter', messages: [] },
  )
}

async function toolCall(ctx, agent, { name = 'read_file', args = {}, result = OK_RESULT } = {}) {
  return ctx.call('tools/post-execute', [createToolExec({ name, args, agent }), result], { kind: 'accept' })
}

/** 直接触发 session/event 的两参监听器。 */
function fireSession(fake, agent, type) {
  const list = fake.handlers.get('session/event') ?? []
  for (const handler of list) handler(agent.session, { type, seq: 1, time: 0, data: {} })
}

test('压缩后重建上下文地图', async () => {
  const fake = createFakeCtx()
  apply(fake.ctx, { everySteps: 0, language: 'zh' })

  const agent = createFakeAgent('cart-1')
  await preStep(fake.ctx, agent, {
    step: 1,
    messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: '给登录页加权鉴' }] }],
  })
  await toolCall(fake.ctx, agent, { name: 'edit_file', args: { path: 'src/login.tsx' } })
  await toolCall(fake.ctx, agent, { name: 'read_file', args: { path: 'src/auth.ts' } })

  // 没有压缩 → 不注入
  const quiet = await preStep(fake.ctx, agent, { step: 2 })
  assert.equal(quiet.messages.length, 0, '默认只在压缩后注入')

  fireSession(fake, agent, 'compaction/end')

  const injected = await preStep(fake.ctx, agent, { step: 3 })
  assert.equal(injected.messages.length, 1)
  const card = injected.messages[0]
  assert.equal(card.source.kind, 'v41pro-cartographer')
  assert.equal(card.source.form, 'snapshot')

  const text = card.content[0].text
  assert.match(text, /上下文地图/)
  assert.match(text, /压缩 1 次/)
  assert.match(text, /src\/login\.tsx/)
  assert.match(text, /src\/auth\.ts/)
  assert.match(text, /重新用工具读一次/)
})

test('压缩后保留证据状态和最近未解决失败', async () => {
  const fake = createFakeCtx()
  apply(fake.ctx, { everySteps: 0 })
  const agent = createFakeAgent('cart-evidence')
  await preStep(fake.ctx, agent, { step: 1 })
  await toolCall(fake.ctx, agent, {
    name: 'pwsh',
    args: { command: 'node --test' },
    result: { isError: false, value: { exitCode: 1 }, content: [{ type: 'text', text: '2 failing\n[exit code: 1]' }] },
  })
  fireSession(fake, agent, 'compaction/end')
  const decision = await preStep(fake.ctx, agent, { step: 2 })
  assert.equal(decision.messages.length, 1)
  assert.match(decision.messages[0].content[0].text, /尚未通过验证/)
  assert.match(decision.messages[0].content[0].text, /node --test/)
  assert.match(decision.messages[0].content[0].text, /不是成功/)
})

test('另一种检查通过不会覆盖此前的测试失败证据', async () => {
  const fake = createFakeCtx()
  apply(fake.ctx, {})
  const agent = createFakeAgent('cart-two-checks')
  await preStep(fake.ctx, agent)
  await toolCall(fake.ctx, agent, { name: 'pwsh', args: { command: 'node --test' }, result: { isError: false, value: { exitCode: 1 }, content: [{ type: 'text', text: '[exit code: 1]' }] } })
  await toolCall(fake.ctx, agent, { name: 'pwsh', args: { command: 'tsc --noEmit' } })
  fireSession(fake, agent, 'compaction/end')
  const decision = await preStep(fake.ctx, agent, { step: 2 })
  assert.match(decision.messages[0]?.content?.[0]?.text ?? '', /尚未通过验证/)
  assert.match(decision.messages[0]?.content?.[0]?.text ?? '', /node --test/)
  assert.match(decision.messages[0]?.content?.[0]?.text ?? '', /tsc --noEmit/)
})

test('普通包含 test 的 Git 命令不算验证证据', async () => {
  const fake = createFakeCtx()
  apply(fake.ctx, {})
  const agent = createFakeAgent('cart-not-test')
  await preStep(fake.ctx, agent)
  await toolCall(fake.ctx, agent, { name: 'pwsh', args: { command: 'git checkout test' } })
  fireSession(fake, agent, 'compaction/end')
  const decision = await preStep(fake.ctx, agent, { step: 2 })
  assert.equal(decision.messages.length, 0)
})

test('地图只注入一次，不会每步重复', async () => {
  const fake = createFakeCtx()
  apply(fake.ctx, { everySteps: 0 })

  const agent = createFakeAgent('cart-2')
  await preStep(fake.ctx, agent, { step: 1 })
  await toolCall(fake.ctx, agent, { name: 'edit_file', args: { path: 'a.ts' } })
  fireSession(fake, agent, 'compaction/end')

  const first = await preStep(fake.ctx, agent, { step: 2 })
  assert.equal(first.messages.length, 1)

  const second = await preStep(fake.ctx, agent, { step: 3 })
  assert.equal(second.messages.length, 0)
})

test('everySteps > 0 时周期性注入', async () => {
  const fake = createFakeCtx()
  apply(fake.ctx, { everySteps: 2 })

  const agent = createFakeAgent('cart-3')
  await preStep(fake.ctx, agent, { step: 1 })
  await toolCall(fake.ctx, agent, { name: 'edit_file', args: { path: 'a.ts' } })

  const injected = []
  for (let step = 2; step <= 6; step += 1) {
    const decision = await preStep(fake.ctx, agent, { step })
    if (decision.messages.length > 0) injected.push(step)
  }
  assert.deepEqual(injected, [2, 4, 6])
})

test('没有可索引内容时不注入空地图', async () => {
  const fake = createFakeCtx()
  apply(fake.ctx, { everySteps: 0 })

  const agent = createFakeAgent('cart-4')
  await preStep(fake.ctx, agent, { step: 1 })
  fireSession(fake, agent, 'compaction/end')
  const decision = await preStep(fake.ctx, agent, { step: 2 })
  assert.equal(decision.messages.length, 0)
})

test('失败的工具调用不计入文件索引', async () => {
  const fake = createFakeCtx()
  apply(fake.ctx, { everySteps: 0 })

  const agent = createFakeAgent('cart-5')
  await preStep(fake.ctx, agent, { step: 1 })
  await toolCall(fake.ctx, agent, {
    name: 'edit_file',
    args: { path: 'broken.ts' },
    result: { isError: true, content: [], error: { message: 'nope' } },
  })
  fireSession(fake, agent, 'compaction/end')
  const decision = await preStep(fake.ctx, agent, { step: 2 })
  assert.equal(decision.messages.length, 0)
})

test('不同会话之间互不串台', async () => {
  const fake = createFakeCtx()
  apply(fake.ctx, { everySteps: 0 })

  const a = createFakeAgent('cart-a')
  const b = createFakeAgent('cart-b')
  await preStep(fake.ctx, a, { step: 1 })
  await preStep(fake.ctx, b, { step: 1 })
  await toolCall(fake.ctx, a, { name: 'edit_file', args: { path: 'only-a.ts' } })
  fireSession(fake, a, 'compaction/end')

  const forB = await preStep(fake.ctx, b, { step: 2 })
  assert.equal(forB.messages.length, 0, 'B 没有压缩也没有内容')

  const forA = await preStep(fake.ctx, a, { step: 2 })
  assert.equal(forA.messages.length, 1)
  assert.match(forA.messages[0].content[0].text, /only-a\.ts/)
})
