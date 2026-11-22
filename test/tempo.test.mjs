import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../src/tempo.js'
import { createFakeCtx, createFakeAgent, createToolExec, OK_RESULT, failResult } from './fake-ctx.mjs'

async function preStep(ctx, agent, { turn = 1, step = 1 } = {}) {
  return ctx.call(
    'agent/pre-step',
    [{ agent, turn, step, messages: [], signal: new AbortController().signal }],
    { kind: 'enter', messages: [] },
  )
}

async function toolCall(ctx, agent, { name = 'bash', args = {}, result = OK_RESULT } = {}) {
  const decision = await ctx.call('tools/post-execute', [createToolExec({ name, args, agent }), result], { kind: 'accept' })
  return decision?.additionalContexts?.[0]
}

test('步数超预算只提醒一次', async () => {
  const { ctx } = createFakeCtx()
  apply(ctx, { maxStepsPerTurn: 3, maxWallClockMs: 0, language: 'zh' })

  const agent = createFakeAgent()
  await preStep(ctx, agent, { step: 1 })
  await preStep(ctx, agent, { step: 5 })

  const first = await toolCall(ctx, agent, { args: { command: 'a' } })
  assert.ok(first)
  assert.equal(first.source.kind, 'v41pro-tempo')
  assert.match(first.content[0].text, /预算/)

  const second = await toolCall(ctx, agent, { args: { command: 'b' } })
  assert.equal(second, undefined, '同一份预算只提醒一次')
})

test('新回合重置预算', async () => {
  const { ctx } = createFakeCtx()
  apply(ctx, { maxStepsPerTurn: 2, maxWallClockMs: 0 })

  const agent = createFakeAgent()
  await preStep(ctx, agent, { turn: 1, step: 1 })
  await preStep(ctx, agent, { turn: 1, step: 4 })
  const first = await toolCall(ctx, agent, { args: { command: 'a' } })
  assert.ok(first)

  await preStep(ctx, agent, { turn: 2, step: 1 })
  await preStep(ctx, agent, { turn: 2, step: 4 })
  const second = await toolCall(ctx, agent, { args: { command: 'b' } })
  assert.ok(second, '新回合应当重新计预算')
})

test('同一工具反复失败触发换路提醒', async () => {
  const { ctx } = createFakeCtx()
  apply(ctx, { maxStepsPerTurn: 0, maxWallClockMs: 0, maxToolFailuresPerTool: 2 })

  const agent = createFakeAgent()
  await preStep(ctx, agent, { step: 1 })
  await toolCall(ctx, agent, { name: 'bash', args: { command: 'x' }, result: failResult('boom') })
  const notice = await toolCall(ctx, agent, { name: 'bash', args: { command: 'y' }, result: failResult('boom') })

  assert.ok(notice)
  assert.match(notice.content[0].text, /bash/)
  assert.match(notice.content[0].text, /失败/)
})

test('不同工具分别计数', async () => {
  const { ctx } = createFakeCtx()
  apply(ctx, { maxStepsPerTurn: 0, maxWallClockMs: 0, maxToolFailuresPerTool: 2 })

  const agent = createFakeAgent()
  await preStep(ctx, agent, { step: 1 })
  await toolCall(ctx, agent, { name: 'bash', args: {}, result: failResult() })
  const notice = await toolCall(ctx, agent, { name: 'read_file', args: {}, result: failResult() })
  assert.equal(notice, undefined)
})

test('挂钟时间超预算会提醒', async () => {
  const { ctx } = createFakeCtx()
  apply(ctx, { maxStepsPerTurn: 0, maxWallClockMs: 1 })

  const agent = createFakeAgent()
  await preStep(ctx, agent, { step: 1 })
  await new Promise(resolve => setTimeout(resolve, 10))
  const notice = await toolCall(ctx, agent)
  assert.ok(notice)
  assert.match(notice.content[0].text, /分钟/)
})

test('steer 模式在收尾时续命一次', async () => {
  const { ctx, emit } = createFakeCtx()
  apply(ctx, { mode: 'steer', maxStepsPerTurn: 2, maxWallClockMs: 0 })

  const agent = createFakeAgent()
  await preStep(ctx, agent, { step: 1 })
  await preStep(ctx, agent, { step: 3 })
  await toolCall(ctx, agent, { args: { command: 'a' } })

  emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
  assert.equal(agent.steered.length, 1)

  emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
  assert.equal(agent.steered.length, 1, '不能无限续命')
})

test('advise 模式不 steer', async () => {
  const { ctx, emit } = createFakeCtx()
  apply(ctx, { mode: 'advise', maxStepsPerTurn: 2, maxWallClockMs: 0 })

  const agent = createFakeAgent()
  await preStep(ctx, agent, { step: 1 })
  await preStep(ctx, agent, { step: 3 })
  await toolCall(ctx, agent)
  emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })

  assert.equal(agent.steered.length, 0)
})
