import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, parseProposal } from '../src/forker.js'
import { createFakeCtx, createFakeAgent, createFakeSubagents } from './fake-ctx.mjs'

const PROPOSAL = [
  '方案：在网关层加一个重试中间件，不改业务代码。',
  '第一步：先写一个失败注入测试复现当前行为。',
  '主要风险：重试放大了非幂等请求的副作用。',
].join('\n')

function invoke(ctx, args, agent) {
  const tool = ctx.tool('pro_fork')
  assert.ok(tool, 'pro_fork 应当被注册')
  return tool.execute(args, { agent, signal: new AbortController().signal })
}

test('并行生成候选并解析三行结构', async () => {
  const subagents = createFakeSubagents(() => PROPOSAL)
  const fake = createFakeCtx({ subagents })
  apply(fake.ctx, { count: 3 })

  const agent = createFakeAgent()
  const value = await invoke(fake, { question: '如何加 retry' }, agent)

  assert.equal(value.candidates.length, 3)
  assert.equal(value.failed.length, 0)
  assert.equal(value.question, '如何加 retry')
  assert.match(value.candidates[0].proposal, /网关层/)
  assert.match(value.candidates[0].firstStep, /失败注入测试/)
  assert.match(value.candidates[0].risk, /幂等/)
  assert.equal(subagents.starts.length, 3)
  assert.equal(subagents.disposed, 3, '每个子代理都必须 dispose')
})

test('用 spawn provider 且父代理与 delivery 正确传递', async () => {
  const subagents = createFakeSubagents(() => PROPOSAL)
  const fake = createFakeCtx({ subagents })
  apply(fake.ctx, {})

  const agent = createFakeAgent('parent-1')
  await invoke(fake, { question: 'q' }, agent)

  assert.equal(subagents.starts[0].spec.provider, 'spawn')
  assert.equal(subagents.starts[0].spec.delivery, 'caller')
  assert.equal(subagents.starts[0].spec.parent, agent)
  assert.match(subagents.starts[0].spec.prompt[0].text, /视角/)
})

test('count 被上限钳制', async () => {
  const subagents = createFakeSubagents(() => PROPOSAL)
  const fake = createFakeCtx({ subagents })
  apply(fake.ctx, { count: 3, maxCount: 2 })

  await invoke(fake, { question: 'q', count: 9 }, createFakeAgent())
  assert.equal(subagents.starts.length, 2)
})

test('自定义 lenses 被采用', async () => {
  const subagents = createFakeSubagents(() => PROPOSAL)
  const fake = createFakeCtx({ subagents })
  apply(fake.ctx, {})

  await invoke(fake, { question: 'q', lenses: ['甲', '乙'] }, createFakeAgent())
  assert.equal(subagents.starts.length, 2)
  assert.match(subagents.starts[0].request.prompt[0].text, /甲/)
  assert.match(subagents.starts[1].request.prompt[0].text, /乙/)
})

test('子代理失败进入 failed 而不是抛出', async () => {
  const subagents = {
    async startActivation() {
      return {
        childId: 'child',
        name: 'agent-1',
        result: Promise.resolve({ stopReason: 'error', output: [] }),
        async dispose() {},
      }
    },
  }
  const fake = createFakeCtx({ subagents })
  apply(fake.ctx, { count: 2 })

  const value = await invoke(fake, { question: 'q' }, createFakeAgent())
  assert.equal(value.candidates.length, 0)
  assert.equal(value.failed.length, 2)
  assert.equal(value.failed[0].reason, 'error')
})

test('缺少 question 时报错', async () => {
  const fake = createFakeCtx({ subagents: createFakeSubagents(() => PROPOSAL) })
  apply(fake.ctx, {})
  await assert.rejects(invoke(fake, {}, createFakeAgent()), /question/)
})

test('parseProposal 对残缺输出宽松处理', () => {
  const parsed = parseProposal('这里是一段完全不符合格式的自由文本，但仍然是有用的方案。')
  assert.match(parsed.proposal, /自由文本/)
  assert.equal(parsed.firstStep, '(未给出)')
  assert.equal(parsed.risk, '(未给出)')
})

test('parseProposal 支持半角冒号与英文标签', () => {
  const parsed = parseProposal('PROPOSAL: do it\nFIRST STEP: read\nMAIN RISK: none')
  assert.equal(parsed.proposal, 'do it')
  assert.equal(parsed.firstStep, 'read')
  assert.equal(parsed.risk, 'none')
})
