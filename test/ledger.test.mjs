import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { apply, __removeSessionFile } from '../src/ledger.js'
import { createFakeCtx, createFakeAgent, createToolExec, OK_RESULT, failResult } from './fake-ctx.mjs'

const USER_MESSAGE = {
  source: { kind: 'user' },
  content: [{ type: 'text', text: '把登录页的按钮改成蓝色' }],
}

async function preStep(ctx, agent, { turn = 1, step = 1, messages = [] } = {}) {
  return ctx.call(
    'agent/pre-step',
    [{ agent, turn, step, messages, signal: new AbortController().signal }],
    { kind: 'enter', messages: [] },
  )
}

async function toolCall(ctx, agent, { name = 'bash', args = {}, result = OK_RESULT } = {}) {
  return ctx.call('tools/post-execute', [createToolExec({ name, args, agent }), result], { kind: 'accept' })
}

test('记录改动与失败，到点注入现状卡', async () => {
  const { ctx } = createFakeCtx()
  apply(ctx, { persist: false, everySteps: 2, language: 'zh' })

  const agent = createFakeAgent('ledger-1')
  const first = await preStep(ctx, agent, { step: 1, messages: [USER_MESSAGE] })
  assert.equal(first.messages.length, 0, '第一次 pre-step 不该注入空台账')

  await toolCall(ctx, agent, { name: 'edit_file', args: { path: 'src/login.tsx' } })
  await toolCall(ctx, agent, { name: 'bash', args: { command: 'pnpm test' }, result: failResult('3 failed') })

  const second = await preStep(ctx, agent, { step: 2 })
  assert.equal(second.kind, 'enter')
  assert.equal(second.messages.length, 1, '应当注入一张现状卡')

  const card = second.messages[0]
  assert.equal(card.source.kind, 'v41pro-ledger')
  assert.equal(card.source.form, 'snapshot')
  const text = card.content[0].text

  assert.match(text, /现状卡/)
  assert.match(text, /把登录页的按钮改成蓝色/, '要记住本轮目标')
  assert.match(text, /src\/login\.tsx/, '要记住改过的文件')
  assert.match(text, /失败过/, '要记住失败过的做法')
  assert.match(text, /pnpm test/)
})

test('没有历史时不注入噪声', async () => {
  const { ctx } = createFakeCtx()
  apply(ctx, { persist: false, everySteps: 1 })
  const agent = createFakeAgent('ledger-2')
  for (let index = 1; index <= 5; index += 1) {
    const decision = await preStep(ctx, agent, { step: index, messages: index === 1 ? [USER_MESSAGE] : [] })
    assert.equal(decision.messages.length, 0)
  }
})

test('注入节奏受 everySteps 控制', async () => {
  const { ctx } = createFakeCtx()
  apply(ctx, { persist: false, everySteps: 3 })
  const agent = createFakeAgent('ledger-3')

  await preStep(ctx, agent, { step: 1 })
  await toolCall(ctx, agent, { name: 'write_file', args: { path: 'a.js' } })

  const injected = []
  for (let index = 2; index <= 10; index += 1) {
    const decision = await preStep(ctx, agent, { step: index })
    if (decision.messages.length > 0) injected.push(index)
  }
  assert.deepEqual(injected, [2, 5, 8], '每 3 步一次，从第一次有机会开始')
})

test('落盘后能在新会话里恢复', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v41pro-ledger-'))
  const sessionId = 'persist-session'
  try {
    const first = createFakeCtx()
    apply(first.ctx, { persist: true, dir, everySteps: 1 })
    const agent = createFakeAgent(sessionId)
    first.emit('agent/created', { agent, source: 'startup' })
    await preStep(first.ctx, agent, { step: 1, messages: [USER_MESSAGE] })
    await toolCall(first.ctx, agent, { name: 'edit_file', args: { path: 'src/app.ts' } })

    const file = path.join(dir, `${sessionId}.json`)
    await waitFor(() => fs.existsSync(file), 2000)
    assert.ok(fs.existsSync(file), '台账应当落盘')

    const second = createFakeCtx()
    apply(second.ctx, { persist: true, dir, everySteps: 1 })
    const resumed = createFakeAgent(sessionId)
    second.emit('agent/created', { agent: resumed, source: 'resume' })
    // agent/created 的处理器是 async，等一拍
    await new Promise(resolve => setTimeout(resolve, 50))
    const decision = await preStep(second.ctx, resumed, { step: 1 })
    assert.equal(decision.messages.length, 1)
    assert.match(decision.messages[0].content[0].text, /src\/app\.ts/)
  } finally {
    __removeSessionFile(sessionId, dir)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('读取过程中到达的新写入不会被错误标为已保存', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v41pro-ledger-race-'))
  const sessionId = 'race-session'
  const originalRename = fs.promises.rename
  let releaseRename
  fs.promises.rename = async (...args) => {
    await new Promise(resolve => { releaseRename = resolve })
    return originalRename(...args)
  }
  try {
    const { ctx } = createFakeCtx()
    apply(ctx, { persist: true, dir, everySteps: 1 })
    const agent = createFakeAgent(sessionId)
    ctx.emit('agent/created', { agent, source: 'startup' })
    await preStep(ctx, agent, { step: 1, messages: [USER_MESSAGE] })
    await toolCall(ctx, agent, { name: 'edit_file', args: { path: 'old.ts' } })
    await waitFor(() => typeof releaseRename === 'function', 2000)
    await toolCall(ctx, agent, { name: 'edit_file', args: { path: 'new.ts' } })
    releaseRename()
    fs.promises.rename = originalRename
    await waitFor(() => {
      if (!fs.existsSync(path.join(dir, `${sessionId}.json`))) return false
      return JSON.parse(fs.readFileSync(path.join(dir, `${sessionId}.json`), 'utf8')).files['new.ts'] !== undefined
    }, 2000)
    const saved = JSON.parse(fs.readFileSync(path.join(dir, `${sessionId}.json`), 'utf8'))
    assert.ok(saved.files['new.ts'], '排队写入不能因 dirty=false 被跳过')
  } finally {
    fs.promises.rename = originalRename
    releaseRename?.()
    __removeSessionFile(sessionId, dir)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('损坏台账只警告并恢复，不阻塞会话', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v41pro-ledger-corrupt-'))
  const sessionId = 'corrupt-session'
  const warnings = []
  try {
    fs.writeFileSync(path.join(dir, `${sessionId}.json`), '{"files":{"a":', 'utf8')
    const { ctx } = createFakeCtx({ logger: { warn: (...args) => warnings.push(args.join(' ')) } })
    apply(ctx, { persist: true, dir })
    const agent = createFakeAgent(sessionId)
    ctx.emit('agent/created', { agent, source: 'resume' })
    const decision = await preStep(ctx, agent, { step: 1 })
    assert.equal(decision.kind, 'enter')
    assert.ok(warnings.some(text => text.includes('读取台账失败')))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('恢复读取未完成时工具记录不会与旧目标竞争', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v41pro-ledger-load-race-'))
  const sessionId = 'load-race-session'
  const originalRead = fs.promises.readFile
  let releaseRead
  fs.promises.readFile = async (...args) => {
    await new Promise(resolve => { releaseRead = resolve })
    return originalRead(...args)
  }
  try {
    fs.writeFileSync(path.join(dir, `${sessionId}.json`), JSON.stringify({ version: 1, goal: '旧目标', files: { 'old.ts': { count: 1, at: 1 } } }))
    const { ctx } = createFakeCtx()
    apply(ctx, { persist: true, dir })
    const agent = createFakeAgent(sessionId)
    ctx.emit('agent/created', { agent })
    const writing = toolCall(ctx, agent, { name: 'edit_file', args: { path: 'new.ts' } })
    await new Promise(resolve => setTimeout(resolve, 10))
    releaseRead()
    await writing
    fs.promises.readFile = originalRead
    const decision = await preStep(ctx, agent, { step: 1, messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: '新目标' }] }] })
    await waitFor(() => {
      const file = path.join(dir, `${sessionId}.json`)
      if (!fs.existsSync(file)) return false
      return JSON.parse(fs.readFileSync(file, 'utf8')).files['new.ts'] !== undefined
    }, 2000)
    const saved = JSON.parse(fs.readFileSync(path.join(dir, `${sessionId}.json`), 'utf8'))
    assert.ok(saved.files['new.ts'])
    assert.match(decision.messages[0]?.content?.[0]?.text ?? '', /新目标/)
  } finally {
    fs.promises.readFile = originalRead
    releaseRead?.()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('畸形参数不会让监听器抛错', async () => {
  const { ctx } = createFakeCtx()
  apply(ctx, { persist: false })
  const agent = createFakeAgent('ledger-4')
  await assert.doesNotReject(toolCall(ctx, agent, { name: 'edit_file', args: undefined }))
})

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return false
}
