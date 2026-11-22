import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  apply,
  name as pluginName,
  inject,
  DEFAULTS,
  countLines,
  isCodeFile,
  summarizeFindings,
} from '../src/shrink.js'
import {
  createFakeCtx,
  createFakeAgent,
  createToolExec,
  OK_RESULT,
  failResult,
} from './fake-ctx.mjs'

const TEMP_DIRS = []

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v41pro-shrink-'))
  TEMP_DIRS.push(dir)
  return dir
}

after(() => {
  for (const dir of TEMP_DIRS.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/** 写 count 行文本（末尾换行），返回写入内容。 */
function writeLines(file, count) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const text = Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n')
  const content = count > 0 ? `${text}\n` : ''
  fs.writeFileSync(file, content, 'utf8')
  return content
}

function boot({ dir = tempDir(), sessionId = 'session-1', config = {} } = {}) {
  const { ctx, emit, command, tool, dispose } = createFakeCtx()
  apply(ctx, { ...config, dir })
  const agent = createFakeAgent(sessionId)
  return { ctx, emit, command, tool, dispose, agent, dir }
}

async function preStep(ctx, agent, { turn = 1, step = 1 } = {}) {
  return ctx.call(
    'agent/pre-step',
    [{ agent, turn, step, messages: [], signal: new AbortController().signal }],
    { kind: 'enter', messages: [] },
  )
}

async function toolCall(ctx, agent, { toolName = 'edit', args = {}, result = OK_RESULT } = {}) {
  return ctx.call(
    'tools/post-execute',
    [createToolExec({ name: toolName, args, agent }), result],
    { kind: 'accept' },
  )
}

function stopTurn(emit, agent, turn = 1) {
  emit('agent/turn-stopping', { agent, turn, signal: new AbortController().signal })
}

function shrink(tool, agent, args) {
  return tool('code_shrink').execute(args, { agent, signal: new AbortController().signal })
}

function status(command, agent, rawInput = 'status') {
  return command('shrink').handler({ agent, rawInput, signal: new AbortController().signal })
}

// ── 纯函数 / 导出契约 ──────────────────────────────────────────────────────

test('导出契约：name、inject、DEFAULTS 与纯函数', () => {
  assert.equal(pluginName, 'v41pro-shrink')
  assert.deepEqual(inject, ['tools', 'commands'])
  assert.equal(DEFAULTS.enabled, true)
  assert.equal(DEFAULTS.gate, true)
  assert.equal(DEFAULTS.maxNudges, 2)
  assert.equal(DEFAULTS.language, 'zh')
  assert.equal(DEFAULTS.maxFiles, 20)
  assert.ok(DEFAULTS.codeExtensions.includes('.js'))
  assert.ok(DEFAULTS.codeExtensions.includes('.ps1'))
  for (const fn of [apply, countLines, isCodeFile, summarizeFindings]) {
    assert.equal(typeof fn, 'function')
  }
})

test('countLines：空串、末行换行、CRLF', () => {
  assert.equal(countLines(''), 0)
  assert.equal(countLines(null), 0)
  assert.equal(countLines('one'), 1)
  assert.equal(countLines('one\ntwo'), 2)
  assert.equal(countLines('one\ntwo\n'), 2)
  assert.equal(countLines('one\r\ntwo\r\n'), 2)
  assert.equal(countLines('\n'), 1)
})

test('isCodeFile：只认白名单扩展名，大小写与无点写法都兼容', () => {
  assert.equal(isCodeFile('src/a.js', DEFAULTS.codeExtensions), true)
  assert.equal(isCodeFile('src/A.TSX', DEFAULTS.codeExtensions), true)
  assert.equal(isCodeFile('src/a.py', DEFAULTS.codeExtensions), true)
  assert.equal(isCodeFile('README.md', DEFAULTS.codeExtensions), false)
  assert.equal(isCodeFile('package.json', DEFAULTS.codeExtensions), false)
  assert.equal(isCodeFile('', DEFAULTS.codeExtensions), false)
  assert.equal(isCodeFile('src/a.js', ['js']), true)
  assert.equal(isCodeFile('src/a.js', []), false)
})

test('summarizeFindings：汇总三种动作与文件数', () => {
  const summary = summarizeFindings([
    { file: 'a.js', action: 'removed' },
    { file: 'a.js', action: 'kept' },
    { file: 'b.js', action: 'merged' },
    { file: 'b.js', action: 'kept' },
  ])
  assert.equal(summary.total, 4)
  assert.equal(summary.files, 2)
  assert.equal(summary.removed, 1)
  assert.equal(summary.merged, 1)
  assert.equal(summary.kept, 2)
  assert.deepEqual(summarizeFindings(null), { total: 0, files: 0, removed: 0, merged: 0, kept: 0, unknown: 0 })
})

// ── 编辑追踪 ───────────────────────────────────────────────────────────────

test('只追踪编辑类工具改过的代码文件，非代码与只读工具忽略', async () => {
  const dir = tempDir()
  const code = path.join(dir, 'a.js')
  const script = path.join(dir, 'b.py')
  const typed = path.join(dir, 'c.ts')
  const doc = path.join(dir, 'README.md')
  const notes = path.join(dir, 'notes.txt')
  const failed = path.join(dir, 'failed.js')
  for (const file of [code, script, typed, failed]) writeLines(file, 2)
  fs.writeFileSync(doc, '# doc\n', 'utf8')
  fs.writeFileSync(notes, 'notes\n', 'utf8')

  const { ctx, agent, command } = boot({ dir })
  await preStep(ctx, agent)
  await toolCall(ctx, agent, { toolName: 'edit', args: { path: code } })
  await toolCall(ctx, agent, { toolName: 'write', args: { file_path: script } })
  await toolCall(ctx, agent, { toolName: 'apply_patch', args: { files: [typed, doc] } })
  await toolCall(ctx, agent, { toolName: 'read', args: { path: code } })
  await toolCall(ctx, agent, { toolName: 'write', args: { file_path: notes } })
  await toolCall(ctx, agent, { toolName: 'edit', args: { path: failed }, result: failResult('disk full') })

  const result = await status(command, agent)
  assert.equal(result.kind, 'success')
  assert.match(result.text, /a\.js/)
  assert.match(result.text, /b\.py/)
  assert.match(result.text, /c\.ts/)
  assert.doesNotMatch(result.text, /README\.md/)
  assert.doesNotMatch(result.text, /notes\.txt/)
  assert.doesNotMatch(result.text, /failed\.js/)
})

test('兼容宿主契约里的 exec.args 参数名', async () => {
  const dir = tempDir()
  const a = path.join(dir, 'a.js')
  writeLines(a, 3)
  const { ctx, agent, emit } = boot({ dir })
  await preStep(ctx, agent)
  // 契约 §8.4 写的是 exec.args；真实宿主与 fake-ctx 分别用 args / arguments。
  await ctx.call(
    'tools/post-execute',
    [{ name: 'edit', args: { path: a }, agent }, OK_RESULT],
    { kind: 'accept' },
  )
  stopTurn(emit, agent, 1)
  assert.equal(agent.steered.length, 1)
  assert.match(agent.steered[0].content[0].text, /a\.js/)
})

// ── 收尾门禁 ───────────────────────────────────────────────────────────────

test('收尾门禁点名文件、要求删/并/保留理由，升级后标注未验证', async () => {
  const dir = tempDir()
  const a = path.join(dir, 'a.js')
  const b = path.join(dir, 'b.js')
  writeLines(a, 3)
  writeLines(b, 3)

  const { ctx, agent, emit } = boot({ dir })
  await preStep(ctx, agent)
  await toolCall(ctx, agent, { toolName: 'edit', args: { path: a } })
  await toolCall(ctx, agent, { toolName: 'edit', args: { path: b } })

  stopTurn(emit, agent, 1)
  assert.equal(agent.steered.length, 1, '有未审查代码编辑应当催一次')
  const notice = agent.steered[0]
  assert.equal(notice.source.kind, 'v41pro-shrink')
  assert.ok(notice.source.summary.length <= 120, 'summary 不能超过 120 字符')
  const text = notice.content[0].text
  assert.match(text, /a\.js/)
  assert.match(text, /b\.js/)
  assert.match(text, /删/)
  assert.match(text, /并/)
  assert.match(text, /保留/)
  assert.match(text, /理由/)
  assert.match(text, /code_shrink/)
  assert.match(text, /不是用户的新消息/)

  stopTurn(emit, agent, 1)
  assert.equal(agent.steered.length, 2, '第二次收尾应升级为强提醒')
  assert.match(agent.steered[1].content[0].text, /必须调用 `code_shrink`/)

  stopTurn(emit, agent, 1)
  assert.equal(agent.steered.length, 3, '第三次收尾要求标注未验证')
  assert.match(agent.steered[2].content[0].text, /⚠ 未验证/)
  stopTurn(emit, agent, 1)
  assert.equal(agent.steered.length, 3, '标注后不再循环')
})

test('每回合重置待审查集合与催促预算', async () => {
  const dir = tempDir()
  const a = path.join(dir, 'a.js')
  const b = path.join(dir, 'b.js')
  writeLines(a, 3)
  writeLines(b, 3)

  const { ctx, agent, emit } = boot({ dir })
  await preStep(ctx, agent, { turn: 1, step: 1 })
  await toolCall(ctx, agent, { toolName: 'edit', args: { path: a } })
  stopTurn(emit, agent, 1)
  assert.equal(agent.steered.length, 1)

  // 新回合：上一轮的文件不算本轮，也不该复用它消耗掉的催促预算。
  await preStep(ctx, agent, { turn: 2, step: 2 })
  stopTurn(emit, agent, 2)
  assert.equal(agent.steered.length, 1, '上一轮的文件不能跨回合拦截')
  await toolCall(ctx, agent, { toolName: 'edit', args: { path: b } })
  stopTurn(emit, agent, 2)
  assert.equal(agent.steered.length, 2, '新回合重新获得一次催促预算')
  assert.match(agent.steered[1].content[0].text, /b\.js/)
  assert.doesNotMatch(agent.steered[1].content[0].text, /a\.js/)
})

test('gate=false 时照常记录但不拦截；enabled=false 时什么都不注册', async () => {
  const dir = tempDir()
  const a = path.join(dir, 'a.js')
  writeLines(a, 3)
  const off = boot({ dir, config: { gate: false } })
  await preStep(off.ctx, off.agent)
  await toolCall(off.ctx, off.agent, { toolName: 'edit', args: { path: a } })
  stopTurn(off.emit, off.agent, 1)
  assert.equal(off.agent.steered.length, 0)
  assert.ok(off.tool('code_shrink'), '关掉门禁仍应提供工具')
  off.dispose()

  const disabled = boot({ dir: tempDir(), config: { enabled: false } })
  assert.equal(disabled.tool('code_shrink'), undefined)
  assert.equal(disabled.command('shrink'), undefined)
  disabled.dispose()
})

// ── 工具校验 ───────────────────────────────────────────────────────────────

test('没有待审查文件时返回结构化错误', async () => {
  const { ctx, agent, tool } = boot()
  await preStep(ctx, agent)
  const value = await shrink(tool, agent, { findings: [{ file: 'x.js', action: 'kept', detail: '理由' }] })
  assert.equal(value.ok, false)
  assert.equal(value.code, 'no-files')
  assert.equal(value.text.startsWith('❌'), true)
})

test('无 findings 拒绝记录，门禁仍然有效', async () => {
  const dir = tempDir()
  const a = path.join(dir, 'a.js')
  writeLines(a, 3)
  const { ctx, agent, emit, tool, command } = boot({ dir })
  await preStep(ctx, agent)
  await toolCall(ctx, agent, { toolName: 'edit', args: { path: a } })

  const rejected = await shrink(tool, agent, {})
  assert.equal(rejected.ok, false)
  assert.equal(rejected.code, 'missing-findings')
  assert.match(rejected.error, /finding/)
  assert.equal(rejected.findings.length, 0)

  stopTurn(emit, agent, 1)
  assert.equal(agent.steered.length, 1, '拒绝后门禁必须还在')
  const result = await status(command, agent)
  assert.match(result.text, /本轮待审查/)
})

test('缺少某个文件的 finding 时拒绝；补全后才记录', async () => {
  const dir = tempDir()
  const a = path.join(dir, 'a.js')
  const b = path.join(dir, 'b.js')
  writeLines(a, 3)
  writeLines(b, 3)
  const { ctx, agent, tool } = boot({ dir })
  await preStep(ctx, agent)
  await toolCall(ctx, agent, { toolName: 'edit', args: { path: a } })
  await toolCall(ctx, agent, { toolName: 'edit', args: { path: b } })

  const rejected = await shrink(tool, agent, {
    findings: [{ file: a, action: 'removed', detail: '删掉未使用导入' }],
  })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.code, 'missing-coverage')
  assert.match(rejected.error, /b\.js/)

  const value = await shrink(tool, agent, {
    findings: [
      { file: a, action: 'removed', detail: '删掉未使用导入' },
      { file: b, action: 'merged', detail: '并进 a.js 的同名 helper' },
    ],
  })
  assert.equal(value.ok, true)
  assert.equal(value.files.length, 2)
  assert.equal(value.findings.length, 2)
})

test('action=kept 必须有非空理由', async () => {
  const dir = tempDir()
  const a = path.join(dir, 'a.js')
  writeLines(a, 3)
  const { ctx, agent, tool } = boot({ dir })
  await preStep(ctx, agent)
  await toolCall(ctx, agent, { toolName: 'edit', args: { path: a } })

  const rejected = await shrink(tool, agent, {
    findings: [{ file: a, action: 'kept', detail: '   ' }],
  })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.code, 'invalid-finding')
  assert.match(rejected.error, /kept/)

  const invalidAction = await shrink(tool, agent, {
    findings: [{ file: a, action: 'ignored', detail: 'x' }],
  })
  assert.equal(invalidAction.ok, false)
  assert.equal(invalidAction.code, 'invalid-finding')

  const value = await shrink(tool, agent, {
    findings: [{ file: a, action: 'kept', detail: '已经是最小实现，再删就丢可读性' }],
  })
  assert.equal(value.ok, true)
  assert.equal(value.findings[0].detail, '已经是最小实现，再删就丢可读性')
})

test('allow_keep_all 需要 reason，并用 reason 作为整批保留理由', async () => {
  const dir = tempDir()
  const a = path.join(dir, 'a.js')
  writeLines(a, 3)
  const { ctx, agent, tool } = boot({ dir })
  await preStep(ctx, agent)
  await toolCall(ctx, agent, { toolName: 'edit', args: { path: a } })

  const missingReason = await shrink(tool, agent, { allow_keep_all: true })
  assert.equal(missingReason.ok, false)
  assert.equal(missingReason.code, 'keep-all-reason')

  const value = await shrink(tool, agent, {
    allow_keep_all: true,
    reason: '这是最小可复现脚本，删任何一行都会丢证据',
  })
  assert.equal(value.ok, true)
  assert.equal(value.findings.length, 1)
  assert.equal(value.findings[0].action, 'kept')
  assert.match(value.findings[0].detail, /最小可复现/)
})

// ── 行数统计 / 持久化 / 复查后门禁消失 ─────────────────────────────────────

test('行数统计：linesBefore/linesAfter/saved，并把审查记录落盘', async () => {
  const dir = tempDir()
  const file = path.join(dir, 'src', 'a.js')
  writeLines(file, 10)

  const { ctx, agent, tool } = boot({ dir })
  await preStep(ctx, agent)
  await toolCall(ctx, agent, { toolName: 'edit', args: { path: file } }) // 基线 10 行
  writeLines(file, 6) // 模拟模型随后完成的精简

  const value = await shrink(tool, agent, {
    files: [file],
    findings: [{ file, category: 'dead', action: 'removed', detail: '删掉 4 行走不到的分支' }],
  })
  assert.equal(value.ok, true)
  assert.equal(value.linesBefore, 10)
  assert.equal(value.linesAfter, 6)
  assert.equal(value.saved, 4)
  assert.equal(value.files.length, 1)

  const storeFile = path.join(dir, 'session-1.shrink.json')
  assert.equal(fs.existsSync(storeFile), true, '审查成功后必须写盘')
  const saved = JSON.parse(fs.readFileSync(storeFile, 'utf8'))
  assert.ok(saved.reviewedAt > 0)
  assert.equal(saved.findings.length, 1)
  assert.equal(saved.lastStats.saved, 4)
  assert.equal(saved.lastStats.linesBefore, 10)
  assert.equal(saved.lastStats.linesAfter, 6)
})

test('审查之后门禁消失，status 显示上次审查统计', async () => {
  const dir = tempDir()
  const file = path.join(dir, 'a.js')
  writeLines(file, 8)
  const { ctx, agent, emit, tool, command } = boot({ dir })
  await preStep(ctx, agent)
  await toolCall(ctx, agent, { toolName: 'edit', args: { path: file } })

  const value = await shrink(tool, agent, {
    findings: [{ file, action: 'kept', detail: '每一行都被调用，没有可删的' }],
  })
  assert.equal(value.ok, true)

  stopTurn(emit, agent, 1)
  assert.equal(agent.steered.length, 0, '审查完成后不该再拦收尾')

  const result = await status(command, agent)
  assert.match(result.text, /本轮没有待审查/)
  assert.match(result.text, /上次审查/)
  assert.match(result.text, /8 → 8/)
  assert.match(result.text, /kept 1/)
})

test('重建 apply 后从磁盘恢复上次审查记录', async () => {
  const dir = tempDir()
  const file = path.join(dir, 'a.js')
  writeLines(file, 9)

  const first = boot({ dir })
  await preStep(first.ctx, first.agent)
  await toolCall(first.ctx, first.agent, { toolName: 'edit', args: { path: file } })
  writeLines(file, 5)
  const value = await shrink(first.tool, first.agent, {
    files: [file],
    findings: [{ file, action: 'removed', detail: '删掉重复实现，调用已有 helper' }],
  })
  assert.equal(value.saved, 4)
  first.dispose()

  const second = boot({ dir, sessionId: 'session-1' })
  second.emit('agent/created', { agent: second.agent })
  const result = await status(second.command, second.agent)
  assert.equal(result.kind, 'success')
  assert.match(result.text, /上次审查/)
  assert.match(result.text, /9 → 5/)
  assert.match(result.text, /省 4 行/)
  second.dispose()
})
