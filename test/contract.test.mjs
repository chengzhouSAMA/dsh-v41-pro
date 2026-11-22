import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 契约回归测试：钉住 0.2.2-rc.3 的公开接口，防止代码悄悄退回被移除的旧 API。
 *
 * 这些字符串在 rc.3 里已经不存在：
 *   - `agent/request` 瀑布（插件不能再逐请求改 LlmCallConfig）
 *   - `ctx.subagents.start(name, request)`（改为 startActivation）
 *   - `request.toolFilter`（startActivation 没有这个字段）
 *   - `llm.resolveModel()`（公开名字是 resolveModelInfo）
 *   - `agent.steer()` 仍然存在，所以不在此列。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function sources() {
  const dir = path.join(ROOT, 'src')
  const files = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      for (const nested of fs.readdirSync(full)) files.push(path.join(full, nested))
    } else if (entry.name.endsWith('.js')) {
      files.push(full)
    }
  }
  return files
}

/** 只留可执行代码：去掉块注释与行注释，避免文档里提到旧 API 时误报。 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map(line => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')
}

function allCode() {
  return sources().map(file => ({ file, text: stripComments(fs.readFileSync(file, 'utf8')) }))
}

test('代码里不监听已删除的 agent/request 事件', () => {
  for (const { file, text } of allCode()) {
    assert.equal(
      /ctx\.on\(\s*['"]agent\/request['"]/.test(text),
      false,
      `${path.basename(file)} 仍在监听 agent/request（0.2.2-rc.2 起已删除）`,
    )
  }
})

test('代码里不调用旧的 ctx.subagents.start(name, request)', () => {
  for (const { file, text } of allCode()) {
    assert.equal(
      /subagents\.start\s*\(/.test(text),
      false,
      `${path.basename(file)} 仍在调用 ctx.subagents.start（rc.3 只剩 startActivation）`,
    )
  }
})

test('代码里不传已删除的 toolFilter', () => {
  for (const { file, text } of allCode()) {
    assert.equal(
      /\btoolFilter\s*:/.test(text),
      false,
      `${path.basename(file)} 仍在传 toolFilter：startActivation 没有这个字段`,
    )
  }
})

test('模型探测走 resolveModelInfo，升级走 agent.model.select', () => {
  const escalator = fs.readFileSync(path.join(ROOT, 'src', 'escalator.js'), 'utf8')
  assert.match(escalator, /resolveModelInfo/, '必须使用 rc.3 的 llm.resolveModelInfo')
  assert.match(escalator, /model\.select\s*\(/, '必须使用 agent.model.select 写入模型选择')
})

test('纯观察不能退回旧 resolveModel API', () => {
  const escalator = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'escalator.js'), 'utf8'))
  assert.doesNotMatch(escalator, /llm\?\.resolveModel\b/)
})

test('子代理通过 startActivation + delivery 启动', () => {
  for (const name of ['forker.js', 'critic.js']) {
    const text = fs.readFileSync(path.join(ROOT, 'src', name), 'utf8')
    assert.match(text, /startActivation\s*\(/, `${name} 必须使用 startActivation`)
    assert.match(text, /delivery:\s*'caller'/, `${name} 应当用 caller 投递`)
  }
})
