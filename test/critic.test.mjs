import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, parseVerdict } from '../src/critic.js'
import { createFakeCtx, createFakeAgent, createFakeSubagents } from './fake-ctx.mjs'

function invoke(ctx, args, agent) {
  const tool = ctx.tool('pro_critique')
  assert.ok(tool, 'pro_critique 应当被注册')
  return tool.execute(args, { agent, signal: new AbortController().signal })
}

test('复审者明确说通过时 verdict=ok', async () => {
  const subagents = createFakeSubagents('结论：通过\n问题：\n无')
  const fake = createFakeCtx({ subagents })
  apply(fake.ctx, {})

  const value = await invoke(fake, { summary: '改了登录按钮颜色' }, createFakeAgent())
  assert.equal(value.verdict, 'ok')
  assert.match(value.report, /通过/)
  assert.equal(subagents.disposed, 1)
})

test('复审者指出问题时 verdict=issues', async () => {
  const subagents = createFakeSubagents('结论：有问题\n问题：\n1. [阻塞] a.ts — 没有处理空值 — 加上判空')
  const fake = createFakeCtx({ subagents })
  apply(fake.ctx, {})

  const value = await invoke(fake, { summary: 'x', files: ['a.ts'] }, createFakeAgent())
  assert.equal(value.verdict, 'issues')
  assert.match(value.report, /阻塞/)
})

test('输出无法解析时 fail-closed 判为 issues', async () => {
  const subagents = createFakeSubagents('我觉得还行吧。')
  const fake = createFakeCtx({ subagents })
  apply(fake.ctx, {})

  const value = await invoke(fake, { summary: 'x' }, createFakeAgent())
  assert.equal(value.verdict, 'issues')
})

test('复审没跑成时必须报错，不能伪装成通过', async () => {
  const subagents = {
    async startActivation() {
      return {
        childId: 'child',
        name: 'agent-1',
        result: Promise.resolve({ stopReason: 'error', output: [], diagnostic: 'model failed' }),
        async dispose() {},
      }
    },
  }
  const fake = createFakeCtx({ subagents })
  apply(fake.ctx, {})

  await assert.rejects(invoke(fake, { summary: 'x' }, createFakeAgent()), /未能完成/)
})

test('把 spec 与 files 传给复审者', async () => {
  const subagents = createFakeSubagents('结论：通过')
  const fake = createFakeCtx({ subagents })
  apply(fake.ctx, {})

  await invoke(fake, { summary: 's', spec: '用户要 A', files: ['a.ts', 'b.ts'], focus: '异常路径' }, createFakeAgent())
  assert.equal(subagents.starts[0].spec.delivery, 'caller')
  const prompt = subagents.starts[0].spec.prompt[0].text
  assert.match(prompt, /用户要 A/)
  assert.match(prompt, /a\.ts/)
  assert.match(prompt, /异常路径/)
})

test('缺少 summary 时报错', async () => {
  const fake = createFakeCtx({ subagents: createFakeSubagents('结论：通过') })
  apply(fake.ctx, {})
  await assert.rejects(invoke(fake, {}, createFakeAgent()), /summary/)
})

test('parseVerdict 只认明确的通过', () => {
  assert.equal(parseVerdict('结论：通过'), 'ok')
  assert.equal(parseVerdict('VERDICT: PASS'), 'ok')
  assert.equal(parseVerdict('结论: 通过'), 'ok')
  assert.equal(parseVerdict('结论：有问题'), 'issues')
  assert.equal(parseVerdict('可能没什么问题'), 'issues')
  assert.equal(parseVerdict(''), 'issues')
})
