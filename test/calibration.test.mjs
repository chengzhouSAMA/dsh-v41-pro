import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { apply, brierScore, meanAbsError, summarize, DEFAULTS, name } from '../src/calibration.js'
import { createFakeCtx, createFakeAgent } from './fake-ctx.mjs'

const SIGNAL = new AbortController().signal

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'v41pro-calibration-'))
}

/** 起一个指向临时目录的插件实例。 */
function setup(config = {}) {
  const dir = tempDir()
  const fake = createFakeCtx()
  apply(fake.ctx, { dir, ...config })
  return { dir, ...fake }
}

function run(tool, args, agent) {
  return tool.execute(args, { agent, signal: SIGNAL })
}

function readLedger(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'records.json'), 'utf8'))
}

function close(env) {
  env.dispose()
  fs.rmSync(env.dir, { recursive: true, force: true })
}

test('模块元信息符合契约', () => {
  assert.equal(name, 'v41pro-calibration')
  assert.deepEqual(DEFAULTS, { enabled: true, language: 'zh', cap: 500 })
})

test('forecast 校验概率：缺失/越界/非数字返回结构化错误且不落盘', async () => {
  const env = setup()
  try {
    const agent = createFakeAgent('session-validate')
    const forecast = env.tool('forecast')

    for (const probability of [undefined, -0.1, 1.2, 'abc', null]) {
      const value = await run(forecast, { task: '验证概率', probability }, agent)
      assert.equal(value.ok, false, `probability=${String(probability)} 应被拒绝`)
      assert.match(value.text, /probability.*0\.\.1/, '错误文本要说明合法区间')
      assert.equal(typeof value.error, 'string')
    }

    const noTask = await run(forecast, { probability: 0.6 }, agent)
    assert.equal(noTask.ok, false)
    assert.match(noTask.text, /task/)

    const badMinutes = await run(forecast, { task: '验证耗时', probability: 0.6, minutes: -5 }, agent)
    assert.equal(badMinutes.ok, false)
    assert.match(badMinutes.text, /minutes/)

    assert.equal(fs.existsSync(path.join(env.dir, 'records.json')), false, '校验失败不应写账本')
  } finally {
    close(env)
  }
})

test('forecast 写入全局记录：字段完整并返回 id 与未结算数', async () => {
  const env = setup()
  try {
    const agent = createFakeAgent('session-forecast')
    const before = Date.now()
    const value = await run(env.tool('forecast'), {
      task: '迁移脚本',
      probability: 0.65,
      minutes: 30,
      risks: ['兼容性风险'],
      tags: ['db', 'migration'],
    }, agent)

    assert.equal(value.ok, true)
    assert.match(value.id, /^fc-/)
    assert.equal(value.open, 1)

    const ledger = readLedger(env.dir)
    assert.equal(ledger.version, 1)
    assert.equal(ledger.records.length, 1)
    const record = ledger.records[0]
    assert.equal(record.id, value.id)
    assert.equal(record.session, 'session-forecast')
    assert.equal(record.task, '迁移脚本')
    assert.equal(record.probability, 0.65)
    assert.equal(record.minutes, 30)
    assert.deepEqual(record.risks, ['兼容性风险'])
    assert.deepEqual(record.tags, ['db', 'migration'])
    assert.ok(record.createdAt >= before, 'createdAt 应是本次调用的时间戳')
    assert.equal(record.outcome, undefined)
  } finally {
    close(env)
  }
})

test('settle 省略 id 时结算本会话最近一条未结算，且不跨会话', async () => {
  const env = setup()
  try {
    const forecast = env.tool('forecast')
    const settle = env.tool('settle')
    const agentA = createFakeAgent('session-a')
    const agentB = createFakeAgent('session-b')

    const first = await run(forecast, { task: 'A 的第一条', probability: 0.9, minutes: 10 }, agentA)
    const second = await run(forecast, { task: 'A 的第二条', probability: 0.7, minutes: 20 }, agentA)
    const other = await run(forecast, { task: 'B 的一条', probability: 0.5, minutes: 5 }, agentB)

    const settledB = await run(settle, { outcome: 'success' }, agentB)
    assert.equal(settledB.ok, true)
    assert.equal(settledB.id, other.id, '应先结算 B 自己的记录')

    const settledA2 = await run(settle, { outcome: 'failure', actual_minutes: 45, note: '低估依赖' }, agentA)
    assert.equal(settledA2.ok, true)
    assert.equal(settledA2.id, second.id, '应结算 A 最近一条（后写入的）')

    const settledA1 = await run(settle, { outcome: 'success' }, agentA)
    assert.equal(settledA1.ok, true)
    assert.equal(settledA1.id, first.id, '再结算一条就是 A 剩下那条')

    const none = await run(settle, { outcome: 'success' }, agentA)
    assert.equal(none.ok, false)
    assert.match(none.text, /没有未结算/)

    const ledger = readLedger(env.dir)
    const byId = new Map(ledger.records.map(record => [record.id, record]))
    assert.equal(byId.get(first.id).outcome, 'success')
    assert.equal(byId.get(second.id).outcome, 'failure')
    assert.equal(byId.get(second.id).actualMinutes, 45)
    assert.equal(byId.get(second.id).note, '低估依赖')
    assert.ok(byId.get(second.id).settledAt >= byId.get(second.id).createdAt, 'settledAt 应不早于 createdAt')
  } finally {
    close(env)
  }
})

test('settle 指定 id 可跨会话结算；重复结算与未知 id 返回错误文本', async () => {
  const env = setup()
  try {
    const forecast = env.tool('forecast')
    const settle = env.tool('settle')
    const agentA = createFakeAgent('session-owner')
    const agentB = createFakeAgent('session-other')

    const created = await run(forecast, { task: '跨会话结算', probability: 0.4 }, agentA)

    const first = await run(settle, { id: created.id, outcome: 'partial', note: '只完成一半' }, agentB)
    assert.equal(first.ok, true)
    assert.equal(first.id, created.id)
    assert.equal(first.outcome, 'partial')

    const again = await run(settle, { id: created.id, outcome: 'success' }, agentB)
    assert.equal(again.ok, false)
    assert.match(again.text, /已经结算过/)

    const unknown = await run(settle, { id: 'fc-does-not-exist', outcome: 'success' }, agentB)
    assert.equal(unknown.ok, false)
    assert.match(unknown.text, /找不到 id=/)

    const badOutcome = await run(settle, { id: created.id, outcome: 'maybe' }, agentB)
    assert.equal(badOutcome.ok, false)
    assert.match(badOutcome.text, /outcome/)

    const ledger = readLedger(env.dir)
    assert.equal(ledger.records.length, 1)
    assert.equal(ledger.records[0].outcome, 'partial')
  } finally {
    close(env)
  }
})

test('brierScore 只算 success=1/failure=0，partial 与未结算不计入', () => {
  const records = [
    { probability: 0.9, outcome: 'success' },
    { probability: 0.2, outcome: 'failure' },
    { probability: 0.5, outcome: 'partial' },
    { probability: 0.95 },
  ]
  // ((0.9-1)^2 + (0.2-0)^2) / 2 = (0.01 + 0.04) / 2 = 0.025
  const brier = brierScore(records)
  assert.ok(Math.abs(brier - 0.025) < 1e-12, `Brier 应为 0.025，实际 ${brier}`)
  assert.equal(brierScore([]), null, '无样本时返回 null 而不是 0')
  assert.equal(brierScore([{ probability: 0.5, outcome: 'partial' }]), null)
})

test('meanAbsError 只算同时有 minutes 与 actualMinutes 的记录', () => {
  const records = [
    { minutes: 10, actualMinutes: 15, outcome: 'success', probability: 0.8 },
    { minutes: 20, actualMinutes: 20, outcome: 'failure', probability: 0.4 },
    { minutes: 6, actualMinutes: 9, outcome: 'partial', probability: 0.6 },
    { minutes: 30, outcome: 'success', probability: 0.9 },
    { actualMinutes: 12, outcome: 'failure', probability: 0.3 },
  ]
  // (|10-15| + |20-20| + |6-9|) / 3 = 8/3
  const mae = meanAbsError(records)
  assert.ok(Math.abs(mae - 8 / 3) < 1e-12, `MAE 应为 8/3，实际 ${mae}`)
  assert.equal(meanAbsError([]), null)
  assert.equal(meanAbsError([{ minutes: 10 }]), null)
})

test('summarize 汇总 n/open/partial/brier/过度自信/MAE', () => {
  const records = [
    { probability: 0.9, outcome: 'success', minutes: 10, actualMinutes: 12 },
    { probability: 0.4, outcome: 'failure', minutes: 20, actualMinutes: 20 },
    { probability: 0.6, outcome: 'partial', minutes: 6, actualMinutes: 9 },
    { probability: 0.8 },
  ]
  const stats = summarize(records)
  assert.equal(stats.n, 4)
  assert.equal(stats.open, 1)
  assert.equal(stats.partial, 1)
  // 只算 success/failure：((0.9-1)^2 + (0.4-0)^2) / 2 = 0.085
  assert.ok(Math.abs(stats.brier - 0.085) < 1e-12)
  // 预测均值 (0.9 + 0.4) / 2 = 0.65，实际成功率 0.5 → 过度自信 +0.15
  assert.ok(Math.abs(stats.overconfidence - 0.15) < 1e-12)
  // (|10-12| + |20-20| + |6-9|) / 3 = 5/3
  assert.ok(Math.abs(stats.maeMinutes - 5 / 3) < 1e-12)
  assert.equal(summarize([]).overconfidence, null, '无已结算样本时过度自信为 null')
})

test('命令 calibration 展示结算数、Brier、过度自信、耗时 MAE 与最近 5 条', async () => {
  const env = setup()
  try {
    const agent = createFakeAgent('session-command')
    await run(env.tool('forecast'), { task: '写测试', probability: 0.8, minutes: 10 }, agent)
    const created = await run(env.tool('forecast'), { task: '修文档', probability: 0.7, minutes: 5 }, agent)
    await run(env.tool('settle'), { id: created.id, outcome: 'failure' }, agent)
    const first = JSON.parse(fs.readFileSync(path.join(env.dir, 'records.json'), 'utf8')).records[0]
    await run(env.tool('settle'), { id: first.id, outcome: 'success', actual_minutes: 14 }, agent)

    const result = await env.command('calibration').handler({ agent, rawInput: '', signal: SIGNAL })
    assert.equal(result.kind, 'success')
    assert.match(result.text, /已结算 2/)
    assert.match(result.text, /未结算 0/)
    // ((0.8-1)^2 + (0.7-0)^2) / 2 = (0.04 + 0.49) / 2 = 0.265
    assert.match(result.text, /Brier: 0\.265/)
    // 预测均值 0.75，成功率 0.5 → 过度自信 +25.0pp
    assert.match(result.text, /过度自信: \+25\.0pp/)
    // |10-14| / 1 = 4 分钟
    assert.match(result.text, /耗时 MAE: 4\.0 分钟/)
    assert.match(result.text, /写测试/)
    assert.match(result.text, /修文档/)
  } finally {
    close(env)
  }
})

test('重建 apply 后从磁盘恢复账本', async () => {
  const env = setup()
  let restored
  try {
    const agent = createFakeAgent('session-reload')
    const created = await run(env.tool('forecast'), { task: '持久化用例', probability: 0.8, minutes: 10 }, agent)
    await run(env.tool('settle'), { id: created.id, outcome: 'success', actual_minutes: 14 }, agent)
    env.dispose()

    // 新建实例、复用同一个目录，模拟插件重载后从磁盘恢复。
    const fake = createFakeCtx()
    apply(fake.ctx, { dir: env.dir })
    restored = { ...fake, dir: env.dir }

    const agentAfter = createFakeAgent('session-reload')
    const result = await restored.command('calibration').handler({ agent: agentAfter, rawInput: '', signal: SIGNAL })
    assert.equal(result.kind, 'success')
    assert.match(result.text, /已结算 1/)
    assert.match(result.text, /未结算 0/)
    assert.match(result.text, /Brier: 0\.040/)
    assert.match(result.text, /耗时 MAE: 4\.0 分钟/)

    const none = await run(restored.tool('settle'), { outcome: 'success' }, agentAfter)
    assert.equal(none.ok, false)
    assert.match(none.text, /没有未结算/, '已结算状态应从磁盘恢复')
  } finally {
    if (restored) restored.dispose()
    close(env)
  }
})

test('cap 生效：超出上限丢弃最旧记录', async () => {
  const env = setup({ cap: 3 })
  try {
    const agent = createFakeAgent('session-cap')
    const forecast = env.tool('forecast')
    for (const index of [1, 2, 3, 4, 5]) {
      await run(forecast, { task: `任务 ${index}`, probability: 0.5 }, agent)
    }
    const ledger = readLedger(env.dir)
    assert.equal(ledger.records.length, 3)
    assert.deepEqual(ledger.records.map(record => record.task), ['任务 3', '任务 4', '任务 5'])
  } finally {
    close(env)
  }
})

test('enabled=false 时不注册工具与命令', () => {
  const env = setup({ enabled: false })
  try {
    assert.equal(env.toolCount(), 0)
    assert.equal(env.command('calibration'), undefined)
  } finally {
    close(env)
  }
})
