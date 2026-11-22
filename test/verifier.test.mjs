import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../src/verifier.js'
import { createFakeCtx, createFakeAgent, createToolExec, OK_RESULT, failResult } from './fake-ctx.mjs'

function createFakeShell(overrides = {}) {
  const calls = []
  return {
    calls,
    resolve(request) {
      return { ...request, timeoutMs: request.timeoutMs ?? 300_000 }
    },
    async execute(spec) {
      calls.push(spec)
      return {
        async result() {
          return {
            exitCode: 0,
            timedOut: false,
            aborted: false,
            stdout: { text: 'all good', lossy: false },
            stderr: { text: '', lossy: false },
            ...overrides,
          }
        },
      }
    },
  }
}

async function preStep(ctx, agent, { turn = 1, step = 1 } = {}) {
  return ctx.call(
    'agent/pre-step',
    [{ agent, turn, step, messages: [], signal: new AbortController().signal }],
    { kind: 'enter', messages: [] },
  )
}

async function toolCall(ctx, agent, { name = 'bash', args = {}, result = OK_RESULT } = {}) {
  return ctx.call('tools/post-execute', [createToolExec({ name, args, agent }), result], { kind: 'accept' })
}

test('注册 pro_verify 工具', () => {
  const shell = createFakeShell()
  const { ctx, tool } = createFakeCtx({ shell })
  apply(ctx, {})
  assert.ok(tool('pro_verify'), 'pro_verify 应当被注册')
})

test('pro_verify 真正执行命令并返回 exit code', async () => {
  const shell = createFakeShell({ exitCode: 3, stdout: { text: 'FAIL', lossy: false } })
  const { ctx, tool } = createFakeCtx({ shell })
  apply(ctx, { commands: [{ name: 'unit', command: 'pnpm test' }] })

  const agent = createFakeAgent()
  await preStep(ctx, agent)
  const definition = tool('pro_verify')
  const value = await definition.execute({}, { agent, signal: new AbortController().signal })

  assert.equal(value.ok, false)
  assert.equal(value.exitCode, 3)
  assert.equal(value.command, 'pnpm test', '没有传 command 时用配置的第一条')
  assert.match(value.stdout, /FAIL/)
  assert.equal(shell.calls.length, 1)
})

test('改动后未验证就收尾会被拦一次', async () => {
  const shell = createFakeShell()
  const { ctx, emit } = createFakeCtx({ shell })
  apply(ctx, { gate: true, maxNudges: 1, language: 'zh' })

  const agent = createFakeAgent()
  await preStep(ctx, agent, { step: 1 })
  await toolCall(ctx, agent, { name: 'edit_file', args: { path: 'src/app.ts' } })

  emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
  assert.equal(agent.steered.length, 1, '应当催促验证')
  assert.equal(agent.steered[0].source.kind, 'v41pro-verifier')
  assert.match(agent.steered[0].content[0].text, /src\/app\.ts/)

  emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
  assert.equal(agent.steered.length, 1, '只催一次，不能变成死循环')
})

test('模型自己跑了测试且通过，就不拦', async () => {
  const shell = createFakeShell()
  const { ctx, emit } = createFakeCtx({ shell })
  apply(ctx, { gate: true })

  const agent = createFakeAgent()
  await preStep(ctx, agent, { step: 1 })
  await toolCall(ctx, agent, { name: 'edit_file', args: { path: 'src/app.ts' } })
  await toolCall(ctx, agent, {
    name: 'bash',
    args: { command: 'pnpm test' },
    result: { ...OK_RESULT, content: [{ type: 'text', text: 'ℹ tests 10\nℹ pass 10\nℹ fail 0' }] },
  })

  emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
  assert.equal(agent.steered.length, 0, '已经验证过就不该打断')
})

test('验证失败仍然会拦', async () => {
  const shell = createFakeShell()
  const { ctx, emit } = createFakeCtx({ shell })
  apply(ctx, { gate: true })

  const agent = createFakeAgent()
  await preStep(ctx, agent, { step: 1 })
  await toolCall(ctx, agent, { name: 'edit_file', args: { path: 'src/app.ts' } })
  await toolCall(ctx, agent, { name: 'bash', args: { command: 'pnpm test' }, result: failResult('2 failing') })

  emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
  assert.equal(agent.steered.length, 1)
})

test('改动之后又验证通过，顺序正确才放行', async () => {
  const shell = createFakeShell()
  const { ctx, emit } = createFakeCtx({ shell })
  apply(ctx, { gate: true })

  const agent = createFakeAgent()
  await preStep(ctx, agent, { step: 1 })
  await toolCall(ctx, agent, { name: 'bash', args: { command: 'pnpm test' } })
  await toolCall(ctx, agent, { name: 'edit_file', args: { path: 'src/app.ts' } })

  emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
  assert.equal(agent.steered.length, 1, '验证发生在改动之前，不算数')
})

test('gate=false 时只提供工具不拦截', async () => {
  const shell = createFakeShell()
  const { ctx, emit, tool } = createFakeCtx({ shell })
  apply(ctx, { gate: false })

  const agent = createFakeAgent()
  await preStep(ctx, agent, { step: 1 })
  await toolCall(ctx, agent, { name: 'edit_file', args: { path: 'src/app.ts' } })
  emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })

  assert.equal(agent.steered.length, 0)
  assert.ok(tool('pro_verify'))
})

test('没有改动时不拦截', async () => {
  const shell = createFakeShell()
  const { ctx, emit } = createFakeCtx({ shell })
  apply(ctx, { gate: true })

  const agent = createFakeAgent()
  await preStep(ctx, agent, { step: 1 })
  await toolCall(ctx, agent, { name: 'read_file', args: { path: 'src/app.ts' } })
  emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })

  assert.equal(agent.steered.length, 0)
})

test('shell 命令以正常工具结果返回非零退出时仍然拦截', async () => {
  const shell = createFakeShell()
  const { ctx, emit } = createFakeCtx({ shell })
  apply(ctx, { gate: true })
  const agent = createFakeAgent()
  await preStep(ctx, agent)
  await toolCall(ctx, agent, { name: 'edit_file', args: { path: 'src/app.ts' } })
  await toolCall(ctx, agent, {
    name: 'pwsh',
    args: { command: 'node --test' },
    result: { isError: false, value: { exitCode: 1, stdout: { text: '1 failing' }, stderr: { text: '' } }, content: [{ type: 'text', text: '1 failing\n[exit code: 1]' }] },
  })
  emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
  assert.equal(agent.steered.length, 1)
})

test('没有运行任何测试不能关闭验证闸门', async () => {
  const shell = createFakeShell()
  const { ctx, emit } = createFakeCtx({ shell })
  apply(ctx, { gate: true })
  const agent = createFakeAgent()
  await preStep(ctx, agent)
  await toolCall(ctx, agent, { name: 'edit_file', args: { path: 'src/app.ts' } })
  await toolCall(ctx, agent, {
    name: 'bash',
    args: { command: 'npm test' },
    result: { ...OK_RESULT, content: [{ type: 'text', text: 'no test files found' }] },
  })
  emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
  assert.equal(agent.steered.length, 1)
})

test('成功编译即使含 skipped 字样也可以关闭验证闸门', async () => {
  const shell = createFakeShell()
  const { ctx, emit } = createFakeCtx({ shell })
  apply(ctx, { gate: true })
  const agent = createFakeAgent()
  await preStep(ctx, agent)
  await toolCall(ctx, agent, { name: 'edit_file', args: { path: 'src/app.ts' } })
  await toolCall(ctx, agent, {
    name: 'bash',
    args: { command: 'cargo check' },
    result: { ...OK_RESULT, content: [{ type: 'text', text: 'Checking demo\nFinished dev profile (tests skipped)' }] },
  })
  emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
  assert.equal(agent.steered.length, 0)
})

test('pro_verify 超时不能关闭验证闸门', async () => {
  const shell = createFakeShell({ timedOut: true, exitCode: null })
  const { ctx, emit, tool } = createFakeCtx({ shell })
  apply(ctx, {})
  const agent = createFakeAgent()
  await preStep(ctx, agent)
  await toolCall(ctx, agent, { name: 'edit_file', args: { path: 'src/app.ts' } })
  const result = await tool('pro_verify').execute({ command: 'node --test' }, { agent, signal: new AbortController().signal })
  assert.equal(result.ok, false)
  assert.equal(result.timedOut, true)
  emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
  assert.equal(agent.steered.length, 1)
})

test('新一轮没有改动时不因历史文件而拦截', async () => {
  const shell = createFakeShell()
  const { ctx, emit } = createFakeCtx({ shell })
  apply(ctx, {})
  const agent = createFakeAgent()
  await preStep(ctx, agent, { turn: 1, step: 1 })
  await toolCall(ctx, agent, { name: 'edit_file', args: { path: 'src/app.ts' } })
  await preStep(ctx, agent, { turn: 2, step: 2 })
  emit('agent/turn-stopping', { agent, turn: 2, signal: new AbortController().signal })
  assert.equal(agent.steered.length, 0)
})

test('普通含 test 的命令不会覆盖已经通过的验证', async () => {
  const shell = createFakeShell()
  const { ctx, emit } = createFakeCtx({ shell })
  apply(ctx, {})
  const agent = createFakeAgent()
  await preStep(ctx, agent)
  await toolCall(ctx, agent, { name: 'edit_file', args: { path: 'src/app.ts' } })
  await toolCall(ctx, agent, { name: 'bash', args: { command: 'pnpm test' }, result: { ...OK_RESULT, content: [{ type: 'text', text: 'ℹ tests 10\nℹ pass 10\nℹ fail 0' }] } })
  await toolCall(ctx, agent, { name: 'bash', args: { command: 'git checkout test' } })
  emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
  assert.equal(agent.steered.length, 0)
})

test('pro_verify 透传当前会话的沙箱策略', async () => {
  const shell = createFakeShell()
  const sandboxPolicy = { resolve: () => ({ mode: 'read-only', workspaceRoot: 'C:\\work', sessionId: 'session-1' }) }
  const { ctx, tool } = createFakeCtx({ shell })
  ctx.sandboxPolicy = sandboxPolicy
  apply(ctx, {})
  const agent = createFakeAgent()
  await tool('pro_verify').execute({ command: 'node --check a.js' }, { agent, signal: new AbortController().signal })
  assert.equal(shell.calls[0].sandboxPolicy.mode, 'read-only')
})

test('node --test 的真实通过摘要会被识别', async () => {
  const shell = createFakeShell()
  const { ctx, emit } = createFakeCtx({ shell })
  apply(ctx, {})
  const agent = createFakeAgent()
  await preStep(ctx, agent)
  await toolCall(ctx, agent, { name: 'edit_file', args: { path: 'src/app.ts' } })
  await toolCall(ctx, agent, { name: 'pwsh', args: { command: 'node --test test/a.test.mjs' }, result: { ...OK_RESULT, value: { exitCode: 0 }, content: [{ type: 'text', text: 'ℹ tests 2\nℹ pass 2\nℹ fail 0' }] } })
  emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
  assert.equal(agent.steered.length, 0)
})

test('shell 缺失时 pro_verify 给出清晰错误', async () => {
  const { ctx, tool } = createFakeCtx()
  apply(ctx, {})
  // 插件在 inject 缺失时本应休眠；这里直接调用工具是为了验证错误路径可读。
  await assert.rejects(
    tool('pro_verify').execute({ command: 'x' }, { agent: createFakeAgent(), signal: new AbortController().signal }),
    /shell/,
  )
})
