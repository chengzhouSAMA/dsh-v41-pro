/**
 * v41pro-acceptance 的行为测试。
 *
 * 全部用 test/fake-ctx.mjs 的替身，不触网、不依赖真实 shell：
 * shell 用脚本化的假服务，cmd 的通过/失败/超时/抛错都能精确复现。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { DEFAULTS, __createState, apply, inject, name } from '../src/acceptance.js'
import { createFakeAgent, createFakeCtx } from './fake-ctx.mjs'

// ── 测试辅助 ──────────────────────────────────────────────────────────────

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v41pro-acceptance-'))
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => {
      fs.rmSync(dir, { recursive: true, force: true })
    })
}

/**
 * 脚本化的 shell：第 N 次 execute 返回 script[N]（对象或函数），缺省成功。
 */
function createScriptedShell(script = []) {
  const calls = []
  let index = 0
  return {
    calls,
    resolve(request) {
      return { ...request }
    },
    async execute(spec) {
      calls.push(spec)
      const entry = script[index]
      index += 1
      const overrides = typeof entry === 'function' ? entry(spec) : entry
      const result = {
        exitCode: 0,
        timedOut: false,
        aborted: false,
        stdout: { text: '' },
        stderr: { text: '' },
        ...(overrides ?? {}),
      }
      return {
        async result() {
          return result
        },
      }
    },
  }
}

function setup(dir, { shell, config = {} } = {}) {
  const fake = createFakeCtx(shell ? { shell } : {})
  apply(fake.ctx, { dir, ...config })
  return fake
}

function callTool(fake, agent, args) {
  const definition = fake.tool('acceptance')
  assert.ok(definition, 'acceptance 工具没有注册')
  return definition.execute(args, { agent, signal: new AbortController().signal })
}

function preStep(fake, agent, { turn = 1, step = 1 } = {}) {
  const payload = { agent, turn, step, messages: [], signal: new AbortController().signal }
  return fake.call('agent/pre-step', [payload], { kind: 'enter', messages: [] })
}

function messageText(message) {
  return (message?.content ?? [])
    .filter(part => part?.type === 'text')
    .map(part => part.text)
    .join('\n')
}

// ── 注册面 ────────────────────────────────────────────────────────────────

test('模块导出契约并注册工具、命令、四个监听器', () => withTempDir(async dir => {
  assert.equal(name, 'v41pro-acceptance')
  assert.deepEqual(inject, ['tools', 'commands', 'shell'])
  assert.deepEqual({ ...DEFAULTS }, {
    enabled: true,
    gate: true,
    maxNudges: 1,
    language: 'zh',
    maxCriteria: 20,
    timeoutMs: 120_000,
  })

  const fake = setup(dir, { shell: createScriptedShell() })
  const acceptance = fake.tool('acceptance')
  assert.equal(acceptance.name, 'acceptance')
  assert.ok(acceptance.output?.schema, '工具必须有输出 schema')
  assert.equal(typeof acceptance.output.render, 'function')
  const rendered = acceptance.output.render({ action: 'list' }, { text: '视图文本' })
  assert.deepEqual(rendered, [{ type: 'text', text: '视图文本' }])
  assert.equal(acceptance.parameters?.required?.includes('action'), true)

  const accept = fake.command('accept')
  assert.ok(accept, 'accept 命令没有注册')
  assert.equal(typeof accept.handler, 'function')

  assert.equal(fake.handlers.get('agent/created')?.length, 1)
  assert.equal(fake.handlers.get('agent/pre-step')?.length, 1)
  assert.equal(fake.handlers.get('agent/turn-stopping')?.length, 1)
  assert.equal(fake.handlers.get('agent/disposed')?.length, 1)

  const state = __createState(createFakeAgent('s-direct'))
  assert.equal(state.key, 's-direct')
  assert.deepEqual(state.criteria, [])
  assert.equal(state.nudges, 0)

  fake.dispose()
  assert.equal(fake.tool('acceptance'), undefined)
  assert.equal(fake.command('accept'), undefined)
}))

// ── define ────────────────────────────────────────────────────────────────

test('define 默认追加、replace 替换，并校验 text/command/path', () => withTempDir(async dir => {
  const fake = setup(dir, { shell: createScriptedShell() })
  const agent = createFakeAgent('s-define')

  const first = await callTool(fake, agent, {
    action: 'define',
    criteria: [
      { text: '测试通过', command: 'node --test' },
      { text: '产物存在', type: 'file', path: 'dist/app.js' },
    ],
  })
  assert.equal(first.ok, true)
  assert.equal(first.counts.total, 2)
  assert.equal(first.criteria[0].type, 'cmd', '未写 type 时默认 cmd')
  assert.equal(first.criteria[1].type, 'file')

  const appended = await callTool(fake, agent, {
    action: 'define',
    criteria: [{ text: '人工检查文案', type: 'manual' }],
  })
  assert.equal(appended.counts.total, 3)

  const replaced = await callTool(fake, agent, {
    action: 'define',
    replace: true,
    criteria: [{ text: '只剩这条', command: 'exit 0' }],
  })
  assert.equal(replaced.counts.total, 1)
  assert.equal(replaced.criteria[0].text, '只剩这条')

  await assert.rejects(
    callTool(fake, agent, { action: 'define', criteria: [{ command: 'ls' }] }),
    /text/,
  )
  await assert.rejects(
    callTool(fake, agent, { action: 'define', criteria: [{ text: '缺命令' }] }),
    /command/,
  )
  await assert.rejects(
    callTool(fake, agent, { action: 'define', criteria: [{ text: '缺路径', type: 'file' }] }),
    /path/,
  )
  await assert.rejects(
    callTool(fake, agent, { action: 'define', criteria: [{ text: '坏类型', type: 'web' }] }),
    /type/,
  )
  await assert.rejects(
    callTool(fake, agent, { action: 'nope' }),
    /action/,
  )
}))

test('define 超过 maxCriteria 时报错且不落盘', () => withTempDir(async dir => {
  const fake = setup(dir, { config: { maxCriteria: 2 } })
  const agent = createFakeAgent('s-limit')
  const items = [1, 2, 3].map(index => ({ text: `标准 ${index}`, command: 'exit 0' }))
  await assert.rejects(callTool(fake, agent, { action: 'define', criteria: items }), /最多 2 条/)
  const listed = await callTool(fake, agent, { action: 'list' })
  assert.equal(listed.counts.total, 0)
  const defined = await callTool(fake, agent, { action: 'define', criteria: items.slice(0, 2) })
  assert.equal(defined.counts.total, 2)
}))

// ── check ─────────────────────────────────────────────────────────────────

test('check 执行 cmd 并按退出码/文件存在性给出证据', () => withTempDir(async dir => {
  const artifact = path.join(dir, 'artifact.txt')
  const empty = path.join(dir, 'empty.txt')
  fs.writeFileSync(artifact, 'hello')
  fs.writeFileSync(empty, '')

  const shell = createScriptedShell([{ exitCode: 0, stdout: { text: 'v20.0.0' } }])
  const fake = setup(dir, { shell })
  const agent = createFakeAgent('s-check')

  await callTool(fake, agent, {
    action: 'define',
    criteria: [
      { text: '命令返回 0', command: 'node --version' },
      { text: '产物存在', type: 'file', path: artifact },
      { text: '缺失文件', type: 'file', path: path.join(dir, 'missing.txt') },
      { text: '空文件', type: 'file', path: empty },
      { text: '人工确认', type: 'manual' },
    ],
  })

  const checked = await callTool(fake, agent, { action: 'check' })
  assert.equal(shell.calls.length, 1)
  assert.equal(shell.calls[0].command, 'node --version')
  assert.equal(shell.calls[0].timeoutMs, 120_000)
  assert.deepEqual(checked.criteria.map(item => item.status), [
    'verified',
    'verified',
    'failed',
    'failed',
    'pending',
  ])
  assert.equal(checked.ok, false)
  assert.match(checked.criteria[0].evidence, /exit 0/)
  assert.match(checked.criteria[1].evidence, /字节|bytes/)
  assert.match(checked.criteria[2].evidence, /不存在/)
  assert.match(checked.criteria[3].evidence, /空文件/)
  assert.match(checked.text, /2 条通过|2 passed/)
  assert.match(checked.text, /2 条失败|2 failed/)
}))

test('check 对非预期退出码、超时、shell 抛错与异常返回都记 failed 且不抛宿主', () => withTempDir(async dir => {
  const shell = createScriptedShell([
    { exitCode: 2, stderr: { text: 'boom: 编译失败' } },
    { exitCode: 0, timedOut: true },
    { exitCode: 0 },
    { exitCode: 0, aborted: true },
    { exitCode: null }, // handle.result 缺 exitCode 的畸形返回
  ])
  const fake = setup(dir, { shell })
  const agent = createFakeAgent('s-fail')
  await callTool(fake, agent, {
    action: 'define',
    criteria: [
      { text: '编译', command: 'false' },
      { text: '慢命令', command: 'sleep 999', timeout_ms: 5000 },
      { text: '期望 exit 1', command: 'exit 1', expect_exit_code: 1 },
      { text: '被中止', command: 'abort-me' },
      { text: '畸形返回', command: 'weird' },
      { text: '人工确认', type: 'manual' },
    ],
  })
  const checked = await callTool(fake, agent, { action: 'check' })
  assert.deepEqual(checked.criteria.map(item => item.status), [
    'failed',
    'failed',
    'failed',
    'failed',
    'failed',
    'pending',
  ])
  assert.match(checked.criteria[0].evidence, /exit 2/)
  assert.match(checked.criteria[0].evidence, /编译失败/)
  assert.match(checked.criteria[1].evidence, /超时/)
  assert.match(checked.criteria[1].evidence, /5000ms/)
  assert.match(checked.criteria[2].evidence, /期望 1/)
  assert.match(checked.criteria[3].evidence, /中止/)
  assert.match(checked.criteria[4].evidence, /exit -1/)
  assert.match(checked.text, /下一步/)

  // shell.execute 直接抛错：收敛成 failed，不冒泡
  const throwingShell = {
    resolve: request => request,
    async execute() {
      throw new Error('shell 崩了')
    },
  }
  const fake2 = setup(dir, { shell: throwingShell })
  const agent2 = createFakeAgent('s-throw')
  await callTool(fake2, agent2, { action: 'define', criteria: [{ text: '命令', command: 'boom' }] })
  const checked2 = await callTool(fake2, agent2, { action: 'check' })
  assert.equal(checked2.criteria[0].status, 'failed')
  assert.match(checked2.criteria[0].evidence, /执行异常/)
}))

test('没有 shell 服务时 check 不崩，cmd 标准记为 failed 并说明原因', () => withTempDir(async dir => {
  const fake = setup(dir) // 刻意不挂 shell
  const agent = createFakeAgent('s-noshell')
  await callTool(fake, agent, { action: 'define', criteria: [{ text: '命令', command: 'echo hi' }] })
  const checked = await callTool(fake, agent, { action: 'check' })
  assert.equal(checked.ok, false)
  assert.equal(checked.criteria[0].status, 'failed')
  assert.match(checked.criteria[0].evidence, /shell/)
  const viaCommand = await fake.command('accept').handler({ agent, rawInput: 'check' })
  assert.equal(viaCommand.kind, 'success')
  assert.match(viaCommand.text, /失败/)
}))

// ── complete ──────────────────────────────────────────────────────────────

test('complete 只接受全部 verified，否则返回未验证项；修复后可成功', () => withTempDir(async dir => {
  const artifact = path.join(dir, 'out.bin')
  const fake = setup(dir, { shell: createScriptedShell([{ exitCode: 0 }]) })
  const agent = createFakeAgent('s-complete')
  await callTool(fake, agent, {
    action: 'define',
    criteria: [
      { text: '产物生成', type: 'file', path: artifact },
      { text: '测试通过', command: 'node --test' },
    ],
  })

  const refused = await callTool(fake, agent, { action: 'complete' })
  assert.equal(refused.ok, false)
  assert.deepEqual(refused.unverified, ['产物生成', '测试通过'])
  assert.match(refused.text, /被拒绝/)
  assert.equal(refused.counts.pending, 2)

  fs.writeFileSync(artifact, 'built')
  const checked = await callTool(fake, agent, { action: 'check' })
  assert.equal(checked.ok, true)
  assert.equal(checked.counts.verified, 2)

  const done = await callTool(fake, agent, { action: 'complete' })
  assert.equal(done.ok, true)
  assert.deepEqual(done.unverified, [])
  assert.equal(done.counts.verified, 2)
  assert.match(done.text, /已通过/)
}))

// ── 收尾门禁 ──────────────────────────────────────────────────────────────

test('收尾门禁每回合只催一次，文案含未验证项、下一步与 sourceNote', () => withTempDir(async dir => {
  const fake = setup(dir, { shell: createScriptedShell() })
  const agent = createFakeAgent('s-gate')
  await callTool(fake, agent, {
    action: 'define',
    criteria: [
      { text: '测试通过', command: 'node --test' },
      { text: '文档更新', type: 'file', path: 'README.md' },
    ],
  })

  await preStep(fake, agent, { turn: 1 })
  fake.emit('agent/turn-stopping', { agent, turn: 1 })
  assert.equal(agent.steered.length, 1)
  const notice = agent.steered[0]
  assert.equal(notice.source.kind, 'v41pro-acceptance')
  assert.equal(notice.source.form, 'notice')
  assert.ok(notice.source.summary.length <= 120)
  const text = messageText(notice)
  assert.match(text, /测试通过/)
  assert.match(text, /node --test/)
  assert.match(text, /文档更新/)
  assert.match(text, /acceptance check/)
  assert.match(text, /acceptance complete/)
  assert.match(text, /不是用户的新消息/)

  // 同一回合再收尾：不再催
  fake.emit('agent/turn-stopping', { agent, turn: 1 })
  assert.equal(agent.steered.length, 1)

  // 新回合重置 nudges：可以再催一次
  await preStep(fake, agent, { turn: 2 })
  fake.emit('agent/turn-stopping', { agent, turn: 2 })
  assert.equal(agent.steered.length, 2)
}))

test('gate=false 或没有标准时收尾不催；全部 verified 后也不再催', () => withTempDir(async dir => {
  const shell = createScriptedShell([{ exitCode: 0 }])
  const satisfied = setup(dir, { shell })
  const agent = createFakeAgent('s-gate-off')
  await callTool(satisfied, agent, { action: 'define', criteria: [{ text: '测试', command: 'npm test' }] })
  await preStep(satisfied, agent, { turn: 1 })
  satisfied.emit('agent/turn-stopping', { agent, turn: 1 })
  assert.equal(agent.steered.length, 1)
  const checked = await callTool(satisfied, agent, { action: 'check' })
  assert.equal(checked.ok, true)
  await preStep(satisfied, agent, { turn: 2 })
  satisfied.emit('agent/turn-stopping', { agent, turn: 2 })
  assert.equal(agent.steered.length, 1, '全部通过后不该再催')

  const disabled = setup(dir, { shell, config: { gate: false } })
  const agent2 = createFakeAgent('s-gate-disabled')
  await callTool(disabled, agent2, { action: 'define', criteria: [{ text: '测试', command: 'npm test' }] })
  await preStep(disabled, agent2, { turn: 1 })
  disabled.emit('agent/turn-stopping', { agent: agent2, turn: 1 })
  assert.equal(agent2.steered.length, 0, 'gate=false 时不该催')

  const empty = setup(dir, { shell })
  const agent3 = createFakeAgent('s-gate-empty')
  await preStep(empty, agent3, { turn: 1 })
  empty.emit('agent/turn-stopping', { agent: agent3, turn: 1 })
  assert.equal(agent3.steered.length, 0, '没有标准时不该催')
}))

// ── pre-step 注入 ─────────────────────────────────────────────────────────

test('pre-step 进入新回合注入一次待办快照，不每步重复', () => withTempDir(async dir => {
  const fake = setup(dir)
  const agent = createFakeAgent('s-pre')
  await callTool(fake, agent, {
    action: 'define',
    criteria: [
      { text: '测试通过', command: 'npm test' },
      { text: '人工确认', type: 'manual' },
    ],
  })

  const first = await preStep(fake, agent, { turn: 1, step: 1 })
  assert.equal(first.kind, 'enter')
  assert.equal(first.messages.length, 1)
  const snapshot = first.messages[0]
  assert.equal(snapshot.source.kind, 'v41pro-acceptance')
  assert.equal(snapshot.source.form, 'snapshot')
  assert.ok(Array.isArray(snapshot.source.sections))
  const text = messageText(snapshot)
  assert.match(text, /待办验收标准/)
  assert.match(text, /npm test/)
  assert.match(text, /人工确认/)
  assert.match(text, /不是用户的新消息/)

  const second = await preStep(fake, agent, { turn: 1, step: 2 })
  assert.equal(second.messages.length, 0, '同一回合不应每步重复')

  const nextTurn = await preStep(fake, agent, { turn: 2, step: 1 })
  assert.equal(nextTurn.messages.length, 1, '新回合重新注入')

  const terminal = await fake.call(
    'agent/pre-step',
    [{ agent, turn: 3, step: 1, messages: [], signal: new AbortController().signal }],
    { kind: 'stop', messages: [] },
  )
  assert.equal(terminal.kind, 'stop')
  assert.equal(terminal.messages.length, 0, '非 enter 决策不注入')
}))

// ── 持久化 ────────────────────────────────────────────────────────────────

test('重建 apply 后从磁盘恢复标准与检查结果', () => withTempDir(async dir => {
  const missing = path.join(dir, 'never.js')
  const first = setup(dir, { shell: createScriptedShell([{ exitCode: 0 }]) })
  const agent = createFakeAgent('s-persist')
  first.emit('agent/created', { agent })
  await callTool(first, agent, {
    action: 'define',
    criteria: [
      { text: '测试通过', command: 'node --test' },
      { text: '产物存在', type: 'file', path: missing },
    ],
  })
  await callTool(first, agent, { action: 'check' })
  const files = fs.readdirSync(dir)
  assert.ok(files.some(file => file.endsWith('.acceptance.json')), `目录里没有状态文件：${files.join(',')}`)
  first.dispose()

  const resumed = setup(dir, { shell: createScriptedShell([{ exitCode: 0 }]) })
  const resumedAgent = createFakeAgent('s-persist')
  resumed.emit('agent/created', { agent: resumedAgent })
  const listed = await callTool(resumed, resumedAgent, { action: 'list' })
  assert.equal(listed.counts.total, 2)
  assert.deepEqual(listed.criteria.map(item => item.status), ['verified', 'failed'])
  assert.match(listed.text, /测试通过/)
  assert.match(listed.text, /验收标准（1\/2 已通过）/)
}))

// ── 命令 ──────────────────────────────────────────────────────────────────

test('命令 accept 的 status/check/clear 与非法子命令', () => withTempDir(async dir => {
  const shell = createScriptedShell([{ exitCode: 0 }])
  const fake = setup(dir, { shell })
  const agent = createFakeAgent('s-cmd')
  const accept = fake.command('accept')

  const empty = await accept.handler({ agent, rawInput: '' })
  assert.equal(empty.kind, 'success')
  assert.match(empty.text, /还没有定义/)

  await callTool(fake, agent, { action: 'define', criteria: [{ text: '测试通过', command: 'npm test' }] })
  const status = await accept.handler({ agent, rawInput: 'status' })
  assert.equal(status.kind, 'success')
  assert.match(status.text, /测试通过/)
  assert.match(status.text, /待验证/)

  const checked = await accept.handler({ agent, rawInput: 'check', signal: new AbortController().signal })
  assert.equal(checked.kind, 'success')
  assert.match(checked.text, /检查完成/)
  assert.match(checked.text, /通过/)

  const cleared = await accept.handler({ agent, rawInput: 'clear' })
  assert.equal(cleared.kind, 'success')
  assert.match(cleared.text, /已清空 1 条/)
  const after = await accept.handler({ agent, rawInput: 'status' })
  assert.match(after.text, /还没有定义/)

  const bogus = await accept.handler({ agent, rawInput: 'nope' })
  assert.equal(bogus.kind, 'error')
  assert.match(bogus.text, /未知子命令/)
}))
