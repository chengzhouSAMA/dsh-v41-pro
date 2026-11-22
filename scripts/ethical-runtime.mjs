import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import * as ethics from '../src/ethical-conduct.js'
import * as thinking from '../src/thinking.js'

const require = createRequire(join(process.env.DSH_INSTALL_DIR, 'package.json'))
const load = async name => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href)
const { Context } = await load('cordis')
const root = new Context()
root.on('agent/error', ({ error }) => console.error('AGENT ERROR', error))
try {
  for (const name of ['dsh-session', 'dsh-session-projection', 'dsh-llm', 'dsh-agent', 'dsh-tools', 'dsh-system-prompt', 'dsh-tool-executor-native', 'dsh-commands', 'dsh-skill', 'dsh-agent-loop']) {
    const mod = await load(name)
    await root.plugin(mod.default ?? mod)
  }
  const { LlmAdapter, createUserMessage } = await load('dsh-llm')
  const calls = []
  class FixtureAdapter extends LlmAdapter {
    providerInfo(provider) { return { id: provider, name: provider } }
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 100000 }, reasoning: { efforts: ['off', 'low', 'high'].map(id => ({ id, name: id })), defaultEffort: 'off' } } }
    async *stream(options) {
      calls.push(options)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '测试响应' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '测试响应' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  root.llm.registerAdapter(['fixture'], new FixtureAdapter())
  const fiber = await root.plugin(ethics)
  const thought = await root.plugin(thinking, { mode: 'off' })
  const handle = await root.agents.create({ sessionId: 'ethical-runtime-test', agentOptions: { provider: 'fixture', model: 'fixture-model', reasoningEffort: 'off' } })
  const agent = handle.agent
  const body = readFileSync(new URL('../skills/ethical-conduct/SKILL.md', import.meta.url), 'utf8').replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\s*/, '')
  const assertContext = assembly => assert.equal(assembly.contexts.filter(c => c.name === ethics.CONTEXT_NAME && c.text.endsWith(body)).length, 1)
  const requestHasBody = c => JSON.stringify(c).includes(JSON.stringify(body).slice(1, -1))
  const run = async text => {
    const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
    calls.length = 0
    agent.followup(message)
    await agent.whenIdle()
    assert.equal(calls.length, 1)
    assert.ok(Object.isFrozen(calls[0]))
    assert.equal(calls[0].messages.filter(m => m.id === message.id).length, 1)
    return calls[0]
  }
  assert.equal((await root.skills.get('ethical-conduct')).content, body)
  assertContext(await root.systemPrompt.assemble())
  assert.ok(requestHasBody(await run('第一次请求：思考关闭也要加载准则')))
  assert.ok(requestHasBody(await run('第二次请求：同一会话继续加载')))
  const suppress = root.systemPrompt.suppressRuntimeContext()
  const complete = root.systemPrompt.section({ name: 'fixture:complete', order: 0, complete: true, text: '固定自定义系统提示。' })
  assertContext(await root.systemPrompt.assemble())
  assert.ok(requestHasBody(await run('自定义系统提示与关闭可选上下文仍保留准则')))
  await thought.dispose()
  assert.ok(requestHasBody(await run('卸载思考模块仍保留准则')))
  const seed = agent.session.snapshotEvents()
  const restored = await root.agents.create({ sessionId: 'ethical-restored', seed, agentOptions: { provider: 'fixture', model: 'fixture-model' } })
  calls.length = 0
  restored.agent.followup(createUserMessage({ content: [{ type: 'text', text: '恢复后继续' }], source: { kind: 'user' } }))
  await restored.agent.whenIdle()
  assert.equal(calls.length, 1)
  assert.ok(requestHasBody(calls[0]))
  await restored.dispose()
  await fiber.dispose()
  assert.equal(await root.skills.get('ethical-conduct'), undefined)
  assert.equal((await root.systemPrompt.assemble()).contexts.some(c => c.name === ethics.CONTEXT_NAME), false)
  // Historical durable snapshots remain in the log; only current registration is revoked.
  const fresh = await root.agents.create({ sessionId: 'ethical-unloaded', agentOptions: { provider: 'fixture', model: 'fixture-model' } })
  calls.length = 0
  fresh.agent.followup(createUserMessage({ content: [{ type: 'text', text: '卸载后的新会话' }], source: { kind: 'user' } }))
  await fresh.agent.whenIdle()
  assert.equal(calls.length, 1)
  assert.equal(requestHasBody(calls[0]), false)
  await fresh.dispose()
  complete(); suppress()
  await handle.dispose()
  console.log('PASS: ethical-conduct real DSH requests: full body, consecutive requests, thinking off/unload, complete prompt, suppressed optional context, restored session, disposal')
} finally {
  await root.fiber.dispose()
}
