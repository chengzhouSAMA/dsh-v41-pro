#!/usr/bin/env node
/**
 * 本地插件机制场景：使用真实模块与 DSH 事件边界的最小替身，不调用模型。
 * 这不是模型 benchmark；不输出“超越某模型”的结论。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { assessCommandResult } from '../src/core/evidence.js'
import { apply as applyVerifier } from '../src/verifier.js'
import { apply as applyEscalator } from '../src/escalator.js'
import { apply as applyLedger } from '../src/ledger.js'
import { createFakeCtx, createFakeAgent, createToolExec, OK_RESULT, failResult } from '../test/fake-ctx.mjs'

const results = []
async function scenario(name, run) {
  try {
    await run()
    results.push({ name, ok: true })
    console.log(`PASS ${name}`)
  } catch (error) {
    results.push({ name, ok: false, error: String(error?.message ?? error) })
    console.error(`FAIL ${name}: ${error?.message ?? error}`)
    process.exitCode = 1
  }
}

async function preStep(ctx, agent, { turn = 1, step = 1, messages = [] } = {}) {
  return ctx.call('agent/pre-step', [{ agent, turn, step, messages, modelSelection: agent.model.current(), signal: new AbortController().signal }], { kind: 'enter', messages: [] })
}
async function call(ctx, agent, name, args, result = OK_RESULT) {
  return ctx.call('tools/post-execute', [createToolExec({ name, args, agent }), result], { kind: 'accept' })
}

await scenario('非零退出不是通过', () => {
  assert.equal(assessCommandResult({ isError: false, content: [{ type: 'text', text: '[exit code: 1]（说明）' }] }).ok, false)
})

await scenario('零测试不是通过', () => {
  assert.equal(assessCommandResult({ isError: false, content: [{ type: 'text', text: 'ℹ tests 0\nℹ pass 0\nℹ fail 0' }] }, { requireSummary: true }).ok, false)
})

await scenario('验证器识别真实通过并放行', async () => {
  const { ctx, emit } = createFakeCtx({ shell: {} })
  applyVerifier(ctx, {})
  const agent = createFakeAgent('bench-verifier-pass')
  await preStep(ctx, agent)
  await call(ctx, agent, 'edit', { path: 'src/app.ts' })
  await call(ctx, agent, 'pwsh', { command: 'node --test' }, {
    isError: false,
    value: { exitCode: 0 },
    content: [{ type: 'text', text: 'ℹ tests 5\nℹ pass 5\nℹ fail 0' }],
  })
  emit('agent/turn-stopping', { agent })
  assert.equal(agent.steered.length, 0)
})

await scenario('验证器拦截非零退出', async () => {
  const { ctx, emit } = createFakeCtx({ shell: {} })
  applyVerifier(ctx, {})
  const agent = createFakeAgent('bench-verifier-fail')
  await preStep(ctx, agent)
  await call(ctx, agent, 'edit', { path: 'src/app.ts' })
  await call(ctx, agent, 'pwsh', { command: 'node --test' }, {
    isError: false,
    value: { exitCode: 1 },
    content: [{ type: 'text', text: 'ℹ tests 5\nℹ pass 4\nℹ fail 1\n[exit code: 1]' }],
  })
  emit('agent/turn-stopping', { agent })
  assert.equal(agent.steered.length, 1)
})

await scenario('卡住检测识别跨成功读取的相同失败', async () => {
  const { ctx } = createFakeCtx()
  applyEscalator(ctx, { repeatThreshold: 3, cooldownSteps: 0 })
  const agent = createFakeAgent('bench-escalator')
  await preStep(ctx, agent)
  const args = { command: 'node --test' }
  await call(ctx, agent, 'pwsh', args, failResult('1 failing'))
  await call(ctx, agent, 'read', { path: 'a.js' })
  await call(ctx, agent, 'pwsh', args, failResult('1 failing'))
  await call(ctx, agent, 'read', { path: 'b.js' })
  const decision = await call(ctx, agent, 'pwsh', args, failResult('1 failing'))
  assert.match(decision.additionalContexts?.[0]?.content?.[0]?.text ?? '', /重复失败/)
})

await scenario('台账写入后可由同会话 ID 恢复', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v41pro-reliability-'))
  try {
    const first = createFakeCtx()
    applyLedger(first.ctx, { dir, persist: true, everySteps: 1 })
    const agent = createFakeAgent('bench-resume')
    first.emit('agent/created', { agent })
    await preStep(first.ctx, agent, { messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: '恢复任务' }] }] })
    await call(first.ctx, agent, 'edit', { path: 'src/recovered.ts' })
    const deadline = Date.now() + 3000
    const file = path.join(dir, 'bench-resume.json')
    while (!fs.existsSync(file) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    assert.ok(fs.existsSync(file), '台账未落盘')
    const second = createFakeCtx()
    applyLedger(second.ctx, { dir, persist: true, everySteps: 1 })
    const resumed = createFakeAgent('bench-resume')
    second.emit('agent/created', { agent: resumed })
    const decision = await preStep(second.ctx, resumed)
    assert.match(decision.messages[0]?.content?.[0]?.text ?? '', /src\/recovered\.ts/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

const passed = results.filter(result => result.ok).length
console.log(JSON.stringify({
  suite: 'local-reliability-v2',
  scope: 'plugin-mechanisms-only',
  modelComparison: false,
  passed,
  total: results.length,
  ok: passed === results.length,
}, null, 2))
