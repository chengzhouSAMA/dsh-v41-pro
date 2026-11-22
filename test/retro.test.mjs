import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import * as retro from '../src/retro.js'
import { createFakeCtx, createFakeAgent } from './fake-ctx.mjs'

const USER = text => ({ source: { kind: 'user' }, content: [{ type: 'text', text }] })

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'v41pro-retro-'))
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true })
}

function setup(dir, config = {}) {
  const fake = createFakeCtx()
  retro.apply(fake.ctx, { dir, ...config })
  return fake
}

async function callTool(fake, toolName, args, agent) {
  const definition = fake.tool(toolName)
  assert.ok(definition, `工具 ${toolName} 应当已注册`)
  return definition.execute(args, { agent, signal: new AbortController().signal })
}

async function callCommand(fake, commandName, agent, rawInput = '') {
  const definition = fake.command(commandName)
  assert.ok(definition, `命令 ${commandName} 应当已注册`)
  return definition.handler({ agent, rawInput, signal: new AbortController().signal })
}

async function preStep(fake, agent, { turn = 1, step = 1, messages = [] } = {}) {
  return fake.ctx.call(
    'agent/pre-step',
    [{ agent, turn, step, messages, signal: new AbortController().signal }],
    { kind: 'enter', messages: [] },
  )
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return false
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

test('模块声明与注册的工具/命令符合契约，三个必填字段必须非空', async () => {
  assert.equal(retro.name, 'v41pro-retro')
  assert.deepEqual(retro.inject, ['tools', 'commands'])
  assert.deepEqual(retro.DEFAULTS, {
    enabled: true,
    language: 'zh',
    maxRules: 200,
    injectRules: true,
    maxInjected: 3,
  })

  const dir = makeDir()
  try {
    const fake = setup(dir)
    const agent = createFakeAgent('retro-validate')
    fake.emit('agent/created', { agent })
    assert.ok(fake.tool('retro'))
    assert.ok(fake.tool('rules'))
    assert.ok(fake.command('retro'))
    assert.ok(fake.command('rules'))
    assert.equal(fake.handlers.has('agent/turn-stopping'), false, '复盘模块不注册收尾门禁')

    await assert.rejects(callTool(fake, 'retro', { root_cause: 'x', lesson: 'y' }, agent), /summary/)
    await assert.rejects(callTool(fake, 'retro', { summary: '   ', root_cause: 'x', lesson: 'y' }, agent), /summary/)
    await assert.rejects(callTool(fake, 'retro', { summary: 's', lesson: 'y' }, agent), /root_cause/)
    await assert.rejects(callTool(fake, 'retro', { summary: 's', root_cause: 'r' }, agent), /lesson/)
    assert.equal(
      fs.existsSync(path.join(dir, `${agent.session.id}.retro.json`)),
      false,
      '校验失败不应落盘',
    )
  } finally {
    cleanup(dir)
  }
})

test('retro 记录复盘并沉淀规则；rules list 与 /retro 都读得到', async () => {
  const dir = makeDir()
  try {
    const fake = setup(dir)
    const agent = createFakeAgent('retro-record')
    fake.emit('agent/created', { agent })

    const value = await callTool(fake, 'retro', {
      summary: 'pnpm install 在 Windows 下卡住',
      root_cause: '缓存目录被占用',
      lesson: '先清缓存再重试',
      tags: ['pnpm', 'Windows'],
      rule: 'pnpm install 卡住时先清缓存再重试',
    }, agent)

    assert.equal(value.ok, true)
    assert.match(value.id, /^retro-/)
    assert.match(value.ruleId, /^rule-/)
    assert.equal(value.deduped, false)
    assert.match(value.text, /已记录复盘/)

    const session = readJson(path.join(dir, `${agent.session.id}.retro.json`))
    assert.equal(session.version, 1)
    assert.equal(session.items.length, 1)
    assert.equal(session.items[0].summary, 'pnpm install 在 Windows 下卡住')
    assert.equal(session.items[0].rootCause, '缓存目录被占用')
    assert.equal(session.items[0].lesson, '先清缓存再重试')
    assert.deepEqual(session.items[0].tags, ['pnpm', 'Windows'])
    assert.equal(session.items[0].ruleId, value.ruleId)

    const list = await callTool(fake, 'rules', { action: 'list' }, agent)
    assert.equal(list.ok, true)
    assert.equal(list.total, 1)
    assert.equal(list.rules[0].id, value.ruleId)
    assert.equal(list.rules[0].hits, 0)
    assert.equal(list.rules[0].scope, 'global')
    assert.match(list.text, /pnpm install 卡住时先清缓存再重试/)

    const command = await callCommand(fake, 'retro', agent)
    assert.equal(command.kind, 'success')
    assert.match(command.text, /pnpm install 在 Windows 下卡住/)
    assert.match(command.text, /用 retro 工具填写/, '应当给出填写模板')
  } finally {
    cleanup(dir)
  }
})

test('规则按规范化文本去重：重复写入 hits+1、deduped=true、不新增条目', async () => {
  const dir = makeDir()
  try {
    const fake = setup(dir)
    const agent = createFakeAgent('retro-dedupe')
    fake.emit('agent/created', { agent })

    const first = await callTool(fake, 'retro', {
      summary: '改了代码没跑测试',
      root_cause: '急着交付',
      lesson: '改完先跑测试',
      rule: '改完代码必须跑测试',
    }, agent)
    assert.equal(first.deduped, false)

    const second = await callTool(fake, 'retro', {
      summary: '又忘了跑测试',
      root_cause: '同样的问题',
      lesson: '记住先跑测试',
      tags: ['测试'],
      rule: '  改完代码必须跑测试。 ',
    }, agent)
    assert.equal(second.deduped, true)
    assert.equal(second.ruleId, first.ruleId)
    assert.match(second.text, /已合并/)

    const third = await callTool(fake, 'retro', {
      summary: '第三次',
      root_cause: '还是没有跑',
      lesson: '先跑测试',
      rule: '改完代码必须跑测试',
    }, agent)

    assert.equal(third.ruleId, first.ruleId)
    const data = readJson(path.join(dir, 'rules.json'))
    assert.equal(data.version, 1)
    assert.equal(data.rules.length, 1, '规范化后相同只保留一条')
    assert.equal(data.rules[0].hits, 2)
    assert.equal(retro.normalizeRuleText('  改完代码必须跑测试。 '), '改完代码必须跑测试')
  } finally {
    cleanup(dir)
  }
})

test('rules remove 删除规则；未知 id 与错误参数不抛异常，命令错误走 kind=error', async () => {
  const dir = makeDir()
  try {
    const fake = setup(dir)
    const agent = createFakeAgent('retro-remove')
    fake.emit('agent/created', { agent })

    const a = await callTool(fake, 'retro', {
      summary: 'A', root_cause: 'a', lesson: 'la', rule: '规则 A：先读文件',
    }, agent)
    const b = await callTool(fake, 'retro', {
      summary: 'B', root_cause: 'b', lesson: 'lb', rule: '规则 B：再改代码',
    }, agent)

    const removed = await callTool(fake, 'rules', { action: 'remove', id: a.ruleId }, agent)
    assert.equal(removed.ok, true)
    assert.equal(removed.removed, 1)
    assert.match(removed.text, /已删除/)

    const after = await callTool(fake, 'rules', { action: 'list' }, agent)
    assert.equal(after.total, 1)
    assert.equal(after.rules[0].id, b.ruleId)

    const missing = await callTool(fake, 'rules', { action: 'remove', id: 'rule-nope' }, agent)
    assert.equal(missing.ok, false)
    assert.equal(missing.removed, 0)
    const noMatch = await callTool(fake, 'rules', { action: 'list', query: '根本不存在的关键词' }, agent)
    assert.equal(noMatch.ok, true)
    assert.equal(noMatch.total, 0)
    assert.match(noMatch.text, /没有匹配/, '库非空但查询无匹配时不应说"规则库还是空的"')
    await assert.rejects(callTool(fake, 'rules', { action: 'remove' }, agent), /需要 id/)
    await assert.rejects(callTool(fake, 'rules', { action: 'bogus' }, agent), /action/)

    const missingArg = await callCommand(fake, 'rules', agent, 'remove')
    assert.equal(missingArg.kind, 'error')
    assert.match(missingArg.text, /remove <id>/)
    const unknownArg = await callCommand(fake, 'rules', agent, 'wat')
    assert.equal(unknownArg.kind, 'error')
    const removeCommand = await callCommand(fake, 'rules', agent, `remove ${b.ruleId}`)
    assert.equal(removeCommand.kind, 'success')
    const emptyList = await callCommand(fake, 'rules', agent, 'list')
    assert.equal(emptyList.kind, 'success')
    assert.match(emptyList.text, /规则库还是空的/)
  } finally {
    cleanup(dir)
  }
})

test('matchRules：中文 bigram / 英文词 / tags 打分，无关文本不命中且遵守 limit', () => {
  const rules = [
    { id: 'r1', text: 'pnpm install 失败时先清缓存', tags: ['pnpm'], hits: 0, updatedAt: 1 },
    { id: 'r2', text: '改完代码必须跑测试', tags: ['测试'], hits: 5, updatedAt: 2 },
    { id: 'r3', text: '部署前检查环境变量', tags: ['deploy'], hits: 0, updatedAt: 3 },
  ]

  const english = retro.matchRules(rules, 'pnpm install 又失败了，先清缓存吗', 3)
  assert.deepEqual(english.map(rule => rule.id), ['r1'])
  assert.ok(english[0].score >= 2)
  assert.ok(english[0].matched.includes('pnpm'))

  const chinese = retro.matchRules(rules, '改完代码要跑测试再汇报', 3)
  assert.equal(chinese[0].id, 'r2')

  const tagOnly = retro.matchRules(rules, '这次 deploy 很顺利', 3)
  assert.equal(tagOnly[0].id, 'r3', 'tag 命中也要算分')

  assert.deepEqual(retro.matchRules(rules, '帮我画一张海报', 3), [], '无关文本不命中')
  assert.deepEqual(retro.matchRules(rules, '', 3), [])
  assert.deepEqual(retro.matchRules(null, 'pnpm install', 3), [])

  const limited = retro.matchRules(rules, '改完代码跑测试 pnpm install deploy 环境变量', 1)
  assert.equal(limited.length, 1)
})

test('pre-step：用户文本命中才注入一条 snapshot，同回合只注入一次', async () => {
  const dir = makeDir()
  try {
    const fake = setup(dir)
    const seed = createFakeAgent('retro-seed')
    fake.emit('agent/created', { agent: seed })

    const longText = '发布前核对版本号和锁文件，'
      + '否则线上会出现依赖漂移。'.repeat(10)

    const ids = []
    for (const [index, ruleText] of [
      '发布前核对版本号（甲）',
      '发布前核对版本号（乙）',
      '发布前核对版本号（丙）',
      longText,
    ].entries()) {
      const value = await callTool(fake, 'retro', {
        summary: `种子复盘 ${index}`,
        root_cause: '根因',
        lesson: '教训',
        tags: ['发布'],
        rule: ruleText,
      }, seed)
      ids.push(value.ruleId)
      await sleep(2)
    }
    assert.equal(new Set(ids).size, 4, '四条规则应各自独立')

    const agent = createFakeAgent('retro-inject')
    fake.emit('agent/created', { agent })

    const miss = await preStep(fake, agent, { turn: 1, messages: [USER('帮我画一张海报')] })
    assert.equal(miss.messages.length, 0, '不命中不注入')

    const hit = await preStep(fake, agent, { turn: 1, messages: [USER('这次发布前核对版本号了吗')] })
    assert.equal(hit.kind, 'enter')
    assert.equal(hit.messages.length, 1, '命中注入一条快照')

    const snapshot = hit.messages[0]
    assert.equal(snapshot.source.kind, 'v41pro-retro')
    assert.equal(snapshot.source.form, 'snapshot')
    const text = snapshot.content[0].text
    assert.match(text, /相关复盘规则/)
    assert.match(text, /不是用户的新消息/)
    assert.ok(text.includes(longText.slice(0, 20)), '长规则应当被注入')
    const ruleLines = text.split('\n').filter(line => line.startsWith('- '))
    assert.equal(ruleLines.length, 3, '默认最多注入 3 条规则')
    for (const line of ruleLines) {
      assert.ok(line.slice(2).length <= 120, `单条规则不能超过 120 字：${line.slice(2).length}`)
    }
    assert.match(text, /…/, '超长规则应截断并带省略号')

    const again = await preStep(fake, agent, { turn: 1, messages: [USER('发布前还要核对版本号')] })
    assert.equal(again.messages.length, 0, '同一回合只注入一次')

    const nextTurn = await preStep(fake, agent, { turn: 2, messages: [USER('发布前核对版本号')] })
    assert.equal(nextTurn.messages.length, 1, '新回合命中可以再次注入')

    // 命中计数异步累加：不阻塞 pre-step，但最终要落盘。
    const counted = await waitFor(() => {
      const file = path.join(dir, 'rules.json')
      if (!fs.existsSync(file)) return false
      const data = readJson(file)
      const rule = data.rules.find(item => item.id === ids[3])
      return (rule?.hits ?? 0) >= 2
    })
    assert.ok(counted, 'pre-step 命中应异步累加 hits')
  } finally {
    cleanup(dir)
  }
})

test('重建 apply 后从磁盘恢复会话复盘与全局规则', async () => {
  const dir = makeDir()
  const sessionId = 'retro-persist'
  try {
    const first = setup(dir)
    const agent = createFakeAgent(sessionId)
    first.emit('agent/created', { agent })
    await callTool(first, 'retro', {
      summary: '旧复盘：测试挂了没看日志',
      root_cause: '只看了退出码',
      lesson: '先看日志最后 50 行',
      rule: '测试失败先看日志再改代码',
    }, agent)
    first.dispose()

    const second = setup(dir)
    const resumed = createFakeAgent(sessionId)
    second.emit('agent/created', { agent: resumed })

    const command = await callCommand(second, 'retro', resumed)
    assert.equal(command.kind, 'success')
    assert.match(command.text, /旧复盘：测试挂了没看日志/)
    assert.match(command.text, /先看日志最后 50 行/)

    const rules = await callCommand(second, 'rules', resumed)
    assert.equal(rules.kind, 'success')
    assert.match(rules.text, /测试失败先看日志再改代码/)

    // 新规则追加而不是覆盖旧的全局规则。
    await callTool(second, 'retro', {
      summary: '新复盘', root_cause: '新根因', lesson: '新教训', rule: '改文档前先读原文',
    }, resumed)
    const list = await callTool(second, 'rules', { action: 'list' }, resumed)
    assert.equal(list.total, 2)
  } finally {
    cleanup(dir)
  }
})

test('规则总数超过 maxRules 时淘汰最久未用的', async () => {
  const dir = makeDir()
  try {
    const fake = setup(dir, { maxRules: 2 })
    const agent = createFakeAgent('retro-cap')
    fake.emit('agent/created', { agent })

    const ids = []
    for (const rule of ['规则一：先读文件', '规则二：先跑测试', '规则三：先看日志']) {
      const value = await callTool(fake, 'retro', {
        summary: 's', root_cause: 'r', lesson: 'l', rule,
      }, agent)
      ids.push(value.ruleId)
      await sleep(2)
    }

    const list = await callTool(fake, 'rules', { action: 'list' }, agent)
    assert.equal(list.total, 2)
    assert.deepEqual(
      list.rules.map(rule => rule.id).sort(),
      [ids[1], ids[2]].sort(),
      '应淘汰最早写入（最久未用）的规则一',
    )
  } finally {
    cleanup(dir)
  }
})

test('规则库损坏时 pre-step 不抛错、命令返回 kind=error，不打断请求', async () => {
  const dir = makeDir()
  try {
    fs.writeFileSync(path.join(dir, 'rules.json'), '{"rules":', 'utf8')
    const fake = setup(dir)
    const agent = createFakeAgent('retro-corrupt')
    fake.emit('agent/created', { agent })

    const decision = await preStep(fake, agent, { turn: 1, messages: [USER('先跑测试再提交')] })
    assert.equal(decision.kind, 'enter')
    assert.equal(decision.messages.length, 0)

    const command = await callCommand(fake, 'rules', agent)
    assert.equal(command.kind, 'error')
    assert.match(command.text, /规则库操作失败/)
  } finally {
    cleanup(dir)
  }
})

test('规则上限 200 条：会话复盘超过 MAX_ITEMS 时只保留最近 200 条', async () => {
  const dir = makeDir()
  try {
    const fake = setup(dir)
    const agent = createFakeAgent('retro-items')
    fake.emit('agent/created', { agent })
    // 直接验证读取侧的上限：手工写入 205 条，重载后应为 200。
    const file = path.join(dir, `${agent.session.id}.retro.json`)
    const items = Array.from({ length: 205 }, (_, index) => ({
      id: `retro-manual-${index}`,
      at: index,
      summary: `第 ${index} 条`,
      rootCause: '根因',
      lesson: '教训',
      tags: [],
    }))
    fs.writeFileSync(file, JSON.stringify({ version: 1, items }), 'utf8')

    const reloaded = createFakeAgent('retro-items')
    fake.emit('agent/created', { agent: reloaded })
    const command = await callCommand(fake, 'retro', reloaded)
    assert.equal(command.kind, 'success')
    assert.match(command.text, /共 200 条/)

    // 再记一条：仍然是 200 条，且最新的在末尾。
    await callTool(fake, 'retro', { summary: '最新一条', root_cause: 'r', lesson: 'l' }, reloaded)
    const saved = readJson(file)
    assert.equal(saved.items.length, 200)
    assert.equal(saved.items.at(-1).summary, '最新一条')
    assert.equal(saved.items[0].id, 'retro-manual-6')
  } finally {
    cleanup(dir)
  }
})
