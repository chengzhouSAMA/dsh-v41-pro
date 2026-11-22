import test from 'node:test'
import assert from 'node:assert/strict'

import { assessCommandResult, failureFingerprint, redactSecrets, requiresTestEvidence } from '../src/core/evidence.js'

test('非零退出标记不能被当成成功验证', () => {
  const result = assessCommandResult({ isError: false, content: [{ type: 'text', text: '2 failing\n[exit code: 1]' }] })
  assert.equal(result.ok, false)
  assert.equal(result.exitCode, 1)
  assert.equal(result.reason, 'exit-code')
})

test('结构化 shell 结果优先采用真实 exitCode', () => {
  const result = assessCommandResult({ isError: false, value: { exitCode: 2, stdout: { text: 'tests failed' } }, content: [] })
  assert.equal(result.ok, false)
  assert.equal(result.exitCode, 2)
})

test('没有执行结果的测试命令必须 fail-closed', () => {
  const result = assessCommandResult({ isError: false, content: [] }, { requireSummary: true })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'missing-evidence')
})

test('零测试或缺测试文件不是通过', () => {
  for (const text of ['ℹ tests 0\nℹ pass 0\nℹ fail 0', 'no tests ran', 'no test files found']) {
    const result = assessCommandResult({ isError: false, content: [{ type: 'text', text }] }, { requireSummary: true })
    assert.equal(result.ok, false, text)
    assert.equal(result.reason, 'no-tests')
  }
})

test('测试摘要中的失败项优先于表面的 pass 行', () => {
  const text = 'ℹ tests 12\nℹ pass 11\nℹ fail 1\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0'
  const result = assessCommandResult({ isError: false, content: [{ type: 'text', text }] }, { requireSummary: true })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'failed-tests')
})

test('常见测试框架的有效摘要可以作为辅助证据', () => {
  for (const text of ['ℹ tests 61\nℹ pass 61\nℹ fail 0', '12 passed in 0.42s', 'Test Suites: 2 passed, 2 total\nTests: 8 passed, 8 total', 'ok  \texample/pkg\t0.025s']) {
    const result = assessCommandResult({ isError: false, content: [{ type: 'text', text }] }, { requireSummary: true })
    assert.equal(result.ok, true, text)
  }
})

test('超时、停止、后台运行和沙箱拒绝都不能算成功', () => {
  for (const text of ['[timed out after 1000ms]', '[stopped: user]', '[still running after 1000ms; moved to background job abc]', '[sandbox: file access denied under read-only mode]']) {
    const result = assessCommandResult({ isError: false, content: [{ type: 'text', text }] })
    assert.equal(result.ok, false, text)
  }
})

test('pytest 全失败时不能误判为通过', () => {
  const result = assessCommandResult({ isError: false, content: [{ type: 'text', text: '3 failed in 0.2s' }] }, { requireSummary: true })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'failed-tests')
})

test('结构化状态与退出标记冲突时 fail-closed', () => {
  const result = assessCommandResult({ isError: false, value: { exitCode: 0 }, content: [{ type: 'text', text: '[exit code: 1]' }] })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'conflicting-evidence')
})

test('带说明的非零退出标记和负数退出都不能漏检', () => {
  for (const text of ['2 failing\n[exit code: 1]（后台任务）', '[exit code: -1]']) {
    assert.equal(assessCommandResult({ isError: false, content: [{ type: 'text', text }] }).ok, false)
  }
})

test('全部跳过的测试不能算有效通过', () => {
  const text = 'Test Suites: 1 passed, 1 total\nTests: 3 skipped, 3 total'
  const result = assessCommandResult({ isError: false, content: [{ type: 'text', text }] }, { requireSummary: true })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'no-tests')
})

test('失败指纹忽略临时数字但保留工具、参数与失败类别', () => {
  const exec = { name: 'pwsh', arguments: { command: 'pnpm test', description: 'Run tests' } }
  const first = failureFingerprint(exec, { isError: true, error: { message: 'exit 1 at step 12' } })
  const second = failureFingerprint(exec, { isError: true, error: { message: 'exit 1 at step 99' } })
  const different = failureFingerprint(exec, { isError: true, error: { message: 'module not found' } })
  assert.equal(first, second)
  assert.notEqual(first, different)
})

test('含 test 的普通 Git/文件命令不是测试命令', () => {
  for (const command of ['git checkout test', 'echo test', 'mkdir test', 'ls test']) {
    assert.equal(requiresTestEvidence(command), false, command)
  }
  for (const command of ['pnpm test', 'npm run test', 'pytest -q', 'go test ./...', 'make test']) {
    assert.equal(requiresTestEvidence(command), true, command)
  }
})

test('常见凭证不会写进台账', () => {
  const text = redactSecrets('curl -H "Authorization: Bearer abc.def.ghi" --api-key=sk-1234567890 https://x.test?token=abcdef')
  assert.doesNotMatch(text, /abc\.def\.ghi|sk-1234567890|token=abcdef/)
  assert.match(text, /\[redacted\]/)
})
