import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { apply } from '../src/novel.js'
import { createFakeCtx, createFakeAgent } from './fake-ctx.mjs'

async function preStep(ctx, agent, { turn = 1, step = 1 } = {}) {
  return ctx.call(
    'agent/pre-step',
    [{ agent, turn, step, messages: [], signal: new AbortController().signal }],
    { kind: 'enter', messages: [] },
  )
}

test('开启小说会创建大纲与数据库文件', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v41pro-novel-'))
  try {
    const { ctx, tool } = createFakeCtx()
    apply(ctx, { dir })
    const agent = createFakeAgent('novel-session-a')
    const value = await tool('pro_novel').execute(
      { action: 'init', title: '全城高考，我的成绩是复活次数', genre: '都市高武', premise: '死亡回溯' },
      { agent, signal: new AbortController().signal },
    )
    assert.match(value.workId, /^[a-z0-9-]+$/)
    const file = path.join(dir, `${value.workId}.json`)
    assert.ok(fs.existsSync(file), '应落盘数据库')
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(data.title, '全城高考，我的成绩是复活次数')
    assert.equal(data.outline.arcs.length, 0)
    assert.equal(data.userRequirements.length, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('用户要求记录进数据库并可废弃', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v41pro-novel-'))
  try {
    const { ctx, tool } = createFakeCtx()
    apply(ctx, { dir })
    const agent = createFakeAgent('novel-session-b')
    const init = await tool('pro_novel').execute(
      { action: 'init', title: '测试小说', genre: '都市' },
      { agent, signal: new AbortController().signal },
    )
    await tool('pro_novel').execute(
      { action: 'requirement', requirement: '主角能力有代价' },
      { agent, signal: new AbortController().signal },
    )
    await tool('pro_novel').execute(
      { action: 'requirement', requirement: '旧设定已放弃', active: false, reason: '与新版冲突' },
      { agent, signal: new AbortController().signal },
    )
    const data = JSON.parse(fs.readFileSync(path.join(dir, `${init.workId}.json`), 'utf8'))
    assert.equal(data.userRequirements.length, 2)
    assert.equal(data.userRequirements[0].active, true)
    assert.equal(data.userRequirements[1].active, false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('每回合注入现状卡并重读数据库，废弃要求不再注入', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v41pro-novel-'))
  try {
    const { ctx, tool } = createFakeCtx()
    apply(ctx, { dir })
    const agent = createFakeAgent('novel-session-c')
    await tool('pro_novel').execute(
      { action: 'init', title: '测试小说', premise: '回溯' },
      { agent, signal: new AbortController().signal },
    )
    await tool('pro_novel').execute(
      { action: 'requirement', requirement: 'A 要求' },
      { agent, signal: new AbortController().signal },
    )
    await tool('pro_novel').execute(
      { action: 'requirement', requirement: 'B 要求' },
      { agent, signal: new AbortController().signal },
    )

    const first = await preStep(ctx, agent, { turn: 1 })
    const card = first.messages[0]?.content?.[0]?.text ?? ''
    assert.match(card, /测试小说/)
    assert.match(card, /A 要求/)
    assert.match(card, /B 要求/)

    await tool('pro_novel').execute(
      { action: 'requirement', requirement: 'A 要求', active: false, reason: '已被覆盖' },
      { agent, signal: new AbortController().signal },
    )
    const second = await preStep(ctx, agent, { turn: 2 })
    const card2 = second.messages[0]?.content?.[0]?.text ?? ''
    assert.doesNotMatch(card2, /A 要求/)
    assert.match(card2, /B 要求/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
