import test from 'node:test'
import assert from 'node:assert/strict'
import * as thinking from '../src/thinking.js'

const info = (ids, defaultEffort) => ({ reasoning: { efforts: ids.map(id => ({ id })), defaultEffort } })
test('发散最低 low，聚焦最低 high；保留更高选择', () => {
  assert.equal(thinking.minimumEffort(info(['off', 'low', 'medium', 'high', 'xhigh']), 'off', 'divergent'), 'low')
  assert.equal(thinking.minimumEffort(info(['off', 'low', 'medium', 'high', 'xhigh']), 'low', 'focused'), 'high')
  assert.equal(thinking.minimumEffort(info(['low', 'high', 'xhigh']), 'xhigh', 'focused'), 'xhigh')
})
test('使用能力声明与默认值，不发送不支持的档位或假装达到下限', () => {
  assert.equal(thinking.minimumEffort(info(['high']), undefined, 'divergent'), 'high')
  assert.equal(thinking.minimumEffort(info(['low', 'high'], 'high'), undefined, 'divergent'), 'high')
  assert.throws(() => thinking.minimumEffort(info(['low']), 'low', 'focused'), /high/)
  assert.throws(() => thinking.minimumEffort({}, undefined, 'divergent'), /low/)
  assert.throws(() => thinking.minimumEffort(info(['custom']), 'custom', 'focused'), /high/)
})
test('透彻严格使用 max，不把 high/xhigh/自定义最高档映射为 max', () => {
  for (const current of [undefined, 'off', 'low', 'high', 'xhigh', 'max', 'ultra']) {
    assert.equal(thinking.minimumEffort(info(['off', 'low', 'high', 'xhigh', 'max', 'ultra'], 'high'), current, 'thorough'), 'max')
  }
  for (const ids of [[], ['high'], ['xhigh'], ['ultra'], ['MAX']]) {
    assert.throws(() => thinking.minimumEffort(info(ids), ids[0], 'thorough'), /max/)
  }
})
test('透彻模式重放、继续与新任务均保持透彻，提示要求追根究底与可核验结论', () => {
  let s = command(thinking.initialState(), 'thorough')
  assert.equal(s.mode, 'thorough')
  assert.equal(s.phase, 'thorough')
  for (const e of [response, failed, failed, event('user/message', { id: 'thorough-next', source: { kind: 'user' }, content: [{ type: 'text', text: '新任务' }] })]) s = thinking.foldThinking(s, e)
  assert.equal(s.phase, 'thorough')
  assert.equal(s.reopens, 0)
  assert.equal(command(s, 'focused').phase, 'focused')
  assert.equal(command(s, 'off').mode, 'off')
  const text = thinking.phaseText(s)
  assert.match(text, /仅限 max/)
  for (const keyword of ['根因', '假设', '反例', '交叉验证', '不确定', '内部思维']) assert.ok(text.includes(keyword), keyword)
})
const event = (type, data) => ({ type, data })
const response = event('assistant/message', { message: { content: [] } })
const failed = event('tool/result', { message: { isError: true, content: [] } })
const succeeded = event('tool/result', { message: { content: [] } })
function command(state, mode, kind = 'success') {
  state = thinking.foldThinking(state, event('command/run', { name: 'thinking', args: ` ${mode}`, commandId: 'c1' }))
  return thinking.foldThinking(state, event('command/done', { commandId: 'c1', kind }))
}
test('自动从发散进入聚焦，连续失败回溯不超过两次', () => {
  let s = thinking.initialState()
  assert.equal(s.phase, 'divergent')
  s = thinking.foldThinking(s, response)
  assert.equal(s.phase, 'focused')
  for (let cycle = 1; cycle <= 3; cycle++) {
    s = thinking.foldThinking(thinking.foldThinking(s, failed), failed)
    assert.equal(s.reopens, Math.min(cycle, 2))
    assert.equal(s.phase, cycle <= 2 ? 'divergent' : 'focused')
    s = thinking.foldThinking(s, response)
  }
})
test('成功工具打断连续失败，非零命令退出也算失败', () => {
  let s = thinking.foldThinking(thinking.initialState(), response)
  s = thinking.foldThinking(thinking.foldThinking(s, failed), succeeded)
  s = thinking.foldThinking(s, failed)
  assert.equal(s.phase, 'focused')
  s = thinking.foldThinking(s, event('tool/result', { message: { content: [{ type: 'text', text: '[exit code: 1]' }] } }))
  assert.equal(s.phase, 'divergent')
})
test('手动模式固定，不受工具失败或模型回复影响', () => {
  for (const mode of ['divergent', 'focused']) {
    let s = command(thinking.initialState(), mode)
    s = thinking.foldThinking(thinking.foldThinking(thinking.foldThinking(s, response), failed), failed)
    assert.equal(s.mode, mode)
    assert.equal(s.phase, mode)
  }
})
test('命令完成才切模式，错误结果及非本模块命令不生效', () => {
  assert.equal(command(thinking.initialState(), 'focused', 'error').mode, 'auto')
  assert.equal(command(thinking.initialState(), 'focused').mode, 'focused')
  const s = thinking.initialState()
  assert.equal(thinking.foldThinking(s, event('command/run', { name: 'other', args: 'focused' })), s)
})
test('继续保留阶段，新用户任务重置，非用户文本不能重置', () => {
  const s = { ...thinking.initialState(), phase: 'focused', reopens: 2 }
  const user = (id, text, kind = 'user') => event('user/message', { id, source: { kind }, content: [{ type: 'text', text }] })
  assert.equal(thinking.foldThinking(s, user('a', '继续')).phase, 'focused')
  assert.equal(thinking.foldThinking(s, user('b', '另一个复杂任务')).phase, 'divergent')
  assert.equal(thinking.foldThinking(s, user('b', '另一个复杂任务')).reopens, 0)
  assert.equal(thinking.foldThinking(s, user('c', '新任务', 'tool')), s)
})
test('会话 off 不继续转换，重放日志能恢复模式', () => {
  const log = [event('command/run', { name: 'thinking', args: 'off', commandId: 'x' }),
    event('command/done', { commandId: 'x', kind: 'success' }), response, failed]
  const s = log.reduce(thinking.foldThinking, thinking.initialState())
  assert.equal(s.mode, 'off')
  assert.equal(s.phase, 'divergent')
  assert.equal(s.failures, 0)
})
test('关闭成功立即清理档位所有权，关闭失败保留', () => {
  const baseline = { provider: 'p', model: 'm', reasoningEffort: 'off' }
  const applied = { ...baseline, reasoningEffort: 'high' }
  const s = { ...thinking.initialState(), baseline, applied }
  assert.equal(command(s, 'off').baseline, null)
  assert.equal(command(s, 'off').applied, null)
  assert.deepEqual(command(s, 'off', 'error').applied, applied)
})
