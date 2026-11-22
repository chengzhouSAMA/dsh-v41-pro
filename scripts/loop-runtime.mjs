/**
 * 工程闭环四件套的真实 agent loop 验证（不调收费模型）。
 *
 * 与 thinking-runtime.mjs 同一套路：加载真实 DSH 0.2.2-rc.5 的
 * session / llm / agent / tools / commands / agent-loop，用 fixture adapter
 * 驱动一次完整回合，验证：
 *
 *   - acceptance：cmd + file 检查真的走 shell；未验证收尾只催一次；补齐后放行。
 *   - shrink：写完代码未做精简审查会被拦；交付 findings 后放行。
 *   - calibration：forecast/settle 落盘，/calibration 能算出 Brier 与耗时误差。
 *   - retro：规则写入后，下一次用户消息命中关键词会被回注。
 *
 * 用法：node scripts/loop-runtime.mjs（由 scripts/loop-runtime.ps1 提供 DSH 环境变量）
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v41pro-loop-'))
process.env.DSH_HOME = path.join(tmp, 'home')

const require = createRequire(path.join(process.env.DSH_INSTALL_DIR, 'package.json'))
const load = async name => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href)
const { Context } = await load('cordis')
const root = new Context()
const errors = []
root.on('agent/error', ({ error }) => {
  errors.push(error)
  console.error('AGENT ERROR', error.message)
})

const shellCalls = []
const fakeShell = {
  resolve(request) {
    return { ...request, timeoutMs: request.timeoutMs ?? 5000 }
  },
  async execute(spec) {
    shellCalls.push(spec)
    return {
      async result() {
        return {
          exitCode: /\bFAIL\b/.test(spec.command) ? 1 : 0,
          timedOut: false,
          aborted: false,
          stdout: { text: 'fixture ok', lossy: false },
          stderr: { text: '', lossy: false },
        }
      },
    }
  },
}

try {
  for (const name of ['dsh-session', 'dsh-session-projection', 'dsh-llm', 'dsh-agent', 'dsh-tools', 'dsh-system-prompt', 'dsh-tool-executor-native', 'dsh-commands', 'dsh-skill', 'dsh-agent-loop']) {
    const mod = await load(name)
    await root.plugin(mod.default ?? mod)
  }
  root.provide('shell', fakeShell)

  const { LlmAdapter, createUserMessage } = await load('dsh-llm')
  const acceptance = await import('../src/acceptance.js')
  const calibration = await import('../src/calibration.js')
  const retro = await import('../src/retro.js')
  const shrink = await import('../src/shrink.js')

  const dirs = {
    acceptance: path.join(tmp, 'acceptance'),
    calibration: path.join(tmp, 'calibration'),
    retro: path.join(tmp, 'retro'),
    shrink: path.join(tmp, 'shrink'),
  }
  await root.plugin(acceptance, { dir: dirs.acceptance, language: 'zh' })
  await root.plugin(calibration, { dir: dirs.calibration, language: 'zh' })
  await root.plugin(retro, { dir: dirs.retro, language: 'zh' })
  await root.plugin(shrink, { dir: dirs.shrink, language: 'zh' })

  // fixture 工具：模拟模型写代码。
  const written = []
  root.tools.register({
    name: 'write',
    description: 'fixture 写入文件',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) {
      fs.mkdirSync(path.dirname(args.path), { recursive: true })
      fs.writeFileSync(args.path, args.content)
      written.push(args.path)
      return `wrote ${args.path}`
    },
  })

  let actions = []
  const calls = []
  const historyIds = new Set()
  class FixtureAdapter extends LlmAdapter {
    providerInfo(provider) { return { id: provider, name: provider } }
    async resolveModel(provider, model) {
      return {
        provider,
        id: model,
        name: model,
        context: { contextWindow: 100000 },
        reasoning: {
          efforts: ['off', 'low', 'high', 'max'].map(id => ({ id, name: id })),
          defaultEffort: 'off',
        },
      }
    }
    async *stream(options) {
      calls.push(options)
      const action = actions.shift()
      if (action?.tool) {
        const args = JSON.stringify(action.args ?? {})
        const block = { type: 'tool-call', id: `call-${calls.length}`, name: action.tool, arguments: args }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: args }
        yield { type: 'block-end', index: 0, block }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '好' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '好' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  root.llm.registerAdapter(['fixture'], new FixtureAdapter())

  const handle = await root.agents.create({
    sessionId: 'loop-runtime',
    agentOptions: { provider: 'fixture', model: 'fixture-model', reasoningEffort: 'off' },
  })
  const agent = handle.agent
  const user = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

  const run = async (text, plan) => {
    calls.length = 0
    actions = plan.slice()
    agent.followup(user(text))
    await agent.whenIdle()
    const list = calls.slice()
    const fresh = new Set()
    for (const call of list) {
      for (const message of call.messages ?? []) {
        if (message.id && !historyIds.has(message.id)) fresh.add(message.id)
      }
    }
    for (const id of fresh) historyIds.add(id)
    list.fresh = fresh
    return list
  }

  const notices = (name, batch = calls, form) => {
    const seen = new Set()
    const found = []
    for (const call of batch) {
      for (const message of call.messages ?? []) {
        if (message.source?.kind !== name) continue
        if (form !== undefined && message.source?.form !== form) continue
        if (batch.fresh && !batch.fresh.has(message.id)) continue
        const text = message.content?.[0]?.text ?? ''
        const key = `${message.id}|${text}`
        if (seen.has(key)) continue
        seen.add(key)
        found.push(text)
      }
    }
    return found
  }

  // ── acceptance ──────────────────────────────────────────────────────────
  const artifact = path.join(tmp, 'artifact.txt')
  fs.writeFileSync(artifact, '证据')
  let batch = await run('定义验收标准并收尾', [
    {
      tool: 'acceptance',
      args: {
        action: 'define',
        criteria: [
          { text: '文件存在且非空', type: 'file', path: artifact },
          { text: '命令退出码为 0', type: 'cmd', command: 'node --version' },
        ],
      },
    },
  ])
  const acceptNotices = notices('v41pro-acceptance', batch, 'notice')
  assert.ok(acceptNotices.length >= 1, '未验证收尾应催办')
  assert.match(acceptNotices[0], /未验证|验收/)
  assert.equal(acceptNotices[0].includes('文件存在且非空'), true)
  assert.match(acceptNotices[acceptNotices.length - 1], /⚠ 未验证/, '升级链最终要求在回答末尾标注未验证')
  assert.ok(batch.length <= 8, '催促升级不得无限循环')

  batch = await run('补齐验收并交付', [
    { tool: 'acceptance', args: { action: 'check' } },
    { tool: 'acceptance', args: { action: 'complete' } },
  ])
  assert.equal(notices('v41pro-acceptance', batch, 'notice').length, 0, '全部验证后不得再拦')
  assert.equal(shellCalls.length, 1, 'cmd 标准必须真的走 shell')
  const acceptState = JSON.parse(fs.readFileSync(path.join(dirs.acceptance, 'loop-runtime.acceptance.json'), 'utf8'))
  assert.equal(acceptState.criteria.every(item => item.status === 'verified'), true)

  // ── shrink ──────────────────────────────────────────────────────────────
  const codeFile = path.join(tmp, 'sample.js')
  batch = await run('写一个文件就收尾', [
    { tool: 'write', args: { path: codeFile, content: 'const value = 1\n\n\n' } },
  ])
  const shrinkNotices = notices('v41pro-shrink', batch, 'notice')
  assert.ok(shrinkNotices.length >= 1, '写完代码未做精简审查应催办')
  assert.match(shrinkNotices[0], /精简|更短|code_shrink/)
  assert.match(shrinkNotices[shrinkNotices.length - 1], /⚠ 未验证/, '升级链最终要求在回答末尾标注未验证')

  batch = await run('做精简审查后交付', [
    {
      tool: 'code_shrink',
      args: {
        files: [codeFile],
        findings: [{ file: codeFile, category: 'blank-lines', action: 'removed', detail: '删掉末尾两个空行' }],
      },
    },
  ])
  assert.equal(notices('v41pro-shrink', batch, 'notice').length, 0, '审查后不得再拦')
  const shrinkState = JSON.parse(fs.readFileSync(path.join(dirs.shrink, 'loop-runtime.shrink.json'), 'utf8'))
  assert.equal(shrinkState.findings.length, 1)

  // ── calibration ─────────────────────────────────────────────────────────
  batch = await run('预测并结算', [
    { tool: 'forecast', args: { task: '写完模块', probability: 0.8, minutes: 10 } },
    { tool: 'settle', args: { outcome: 'success', actual_minutes: 12 } },
  ])
  const stats = await root.commands.execute(agent, '/calibration', [], new AbortController().signal)
  assert.equal(stats.result.kind, 'success')
  assert.match(stats.result.text, /Brier/)
  assert.match(stats.result.text, /0\.04/, 'Brier=(0.8-1)^2=0.04')
  assert.equal(fs.existsSync(path.join(dirs.calibration, 'records.json')), true)

  // ── retro ───────────────────────────────────────────────────────────────
  await run('写一条复盘并沉淀规则', [
    {
      tool: 'retro',
      args: {
        summary: '断言写错导致测试红',
        root_cause: '没有先跑最小用例',
        lesson: '断言之前先跑最小用例',
        rule: '遇到测试失败，先跑最小用例复现',
        tags: ['测试', '断言'],
      },
    },
  ])
  const rules = await root.commands.execute(agent, '/rules', [], new AbortController().signal)
  assert.equal(rules.result.kind, 'success')
  assert.match(rules.result.text, /最小用例/)

  batch = await run('测试失败怎么办？先跑最小用例吗', [])
  assert.equal(notices('v41pro-retro', batch, 'snapshot').length, 1, '命中规则应回注一次')
  assert.match(notices('v41pro-retro', batch, 'snapshot')[0], /最小用例/)

  await handle.dispose()
  assert.equal(errors.length, 0, `不应有未预期的 AGENT ERROR：${errors.map(error => error.message).join('; ')}`)
  console.log('PASS: DSH rc.5 real loop: acceptance cmd+file gate once and release, shrink gate and findings, forecast/settle Brier, retro rule injection')
} finally {
  await root.fiber.dispose()
  fs.rmSync(tmp, { recursive: true, force: true })
}
