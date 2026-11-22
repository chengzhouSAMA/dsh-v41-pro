import test from 'node:test'
import assert from 'node:assert/strict'
import { adaptReasoning, capabilitySummary } from '../src/core/capabilities.js'

test('按真实模型能力选择推理档位，不伪造跨厂商别名', () => {
  assert.equal(adaptReasoning({ reasoning: { efforts: [{ id: 'low' }, { id: 'high' }, { id: 'max' }] } }, 'max'), 'max')
  assert.equal(adaptReasoning({ reasoning: { efforts: [{ id: 'low' }, { id: 'medium' }, { id: 'xhigh' }] } }, 'high'), 'medium')
  assert.equal(adaptReasoning({ reasoning: { efforts: [{ id: 'off' }] } }, 'high'), 'off')
  assert.equal(adaptReasoning({}, 'high'), undefined)
  assert.equal(adaptReasoning({ reasoning: { efforts: [{ id: 'low' }], defaultEffort: 'xhigh' } }, 'max'), 'low')
})

test('能力摘要不把模型参数当作插件能力', () => {
  const summary = capabilitySummary({ id: 'qwen4-max-preview', context: { contextWindow: 1_000_000 }, defaultMaxTokens: 393216 })
  assert.equal(summary.contextWindow, 1_000_000)
  assert.equal(summary.outputBudgetShared, false)
  assert.match(summary.note, /插件不能增加/)
})
