/**
 * 全模态模块（内置自 ZTR66/dsh-omni）的契约测试。
 *
 * 覆盖三件整合时最容易悄悄坏掉的事：
 *   1. Host 侧仍注册满 11 个工具，并登记 omni-media 运行时 Skill；
 *   2. Skill 正文从包的共享 skills/ 目录读到（内置化后路径变了）；
 *   3. 同一个 Client 入口同时注册思考模式菜单与「全模态」设置页。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import * as omni from '../omni/index.js'
import { createFakeCtx } from './fake-ctx.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const EXPECTED_TOOLS = [
  'omni_env_check',
  'omni_probe',
  'video_scan',
  'video_frames',
  'audio_analyze',
  'audio_transcribe',
  'audio_speak',
  'audio_cut',
  'video_compose',
  'video_extract_audio',
  'image_generate',
]

test('omni 模块元信息与工具清单', () => {
  assert.equal(omni.name, 'v41pro-omni')
  assert.deepEqual(omni.inject, ['tools'])
  const fake = createFakeCtx({ logger: { info() {} } })
  const stop = omni.apply(fake.ctx, {})
  assert.equal(fake.toolCount(), EXPECTED_TOOLS.length)
  for (const name of EXPECTED_TOOLS) assert.ok(fake.tool(name), `工具 ${name} 未注册`)
  stop()
  assert.equal(fake.toolCount(), 0)
  fake.dispose()
})

test('omni 注册 omni-media Skill，正文来自共享 skills/ 目录', async () => {
  const skillPath = join(ROOT, 'skills', 'omni-media', 'SKILL.md')
  assert.ok(existsSync(skillPath), 'skills/omni-media/SKILL.md 缺失')
  const fake = createFakeCtx({ logger: { info() {} } })
  const stop = omni.apply(fake.ctx, {})
  const skill = await fake.ctx.skills.get('omni-media')
  assert.ok(skill, 'omni-media 未注册')
  assert.equal(skill.invocation, 'auto')
  assert.match(skill.description, /media/i)
  assert.ok(skill.content.length > 500, 'Skill 正文过短，可能读到了 frontmatter 之外的空文件')
  assert.equal(skill.content.startsWith('---'), false, 'frontmatter 未被剥离')
  stop()
})

test('patch 里有 v41pro-omni 行，name 指向包的 omni 入口', () => {
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /- id: v41pro-omni\s*\n\s*name: 'dsh-v41-pro\/omni'/)
})

test('Client 入口同时注册思考模式与全模态设置页', async () => {
  const loaded = []
  const previous = globalThis.window
  globalThis.window = { __ModuleLoader__: { load: (definition) => loaded.push(definition) } }
  try {
    await import(pathToFileURL(join(ROOT, 'client.js')).href + '?omni-test=' + Date.now())
  } finally {
    if (previous === undefined) delete globalThis.window
    else globalThis.window = previous
  }

  assert.equal(loaded.length, 1)
  assert.equal(loaded[0].id, 'dsh-v41-pro')

  const dictionaries = []
  const registered = []
  const module = loaded[0].factory((id) => {
    assert.equal(id, 'react')
    return {
      createElement: (type, props, ...children) => ({ type, props, children }),
      useState: (initial) => [initial, () => {}],
      useEffect: () => {},
      useCallback: (fn) => fn,
    }
  })
  assert.deepEqual(module.inject, ['slots', 'locale', 'remote', 'remote.commands'])

  module.apply({
    effect(fn) {
      return fn()
    },
    locale: {
      register(namespace, dicts) {
        dictionaries.push({ namespace, dicts })
        return () => {}
      },
    },
    slots: {
      inject(_name, register) {
        register()
      },
      register(registration, component) {
        registered.push({ registration, component })
        return () => {}
      },
    },
    remote: {
      commands: {
        async execute() {
          return { ok: true, value: {} }
        },
      },
    },
  })

  assert.deepEqual(dictionaries.map((entry) => entry.namespace), ['thinking-ui'])
  const byId = new Map(registered.map((entry) => [entry.registration.id, entry]))
  assert.ok(byId.has('v41pro-thinking'))
  assert.equal(byId.get('v41pro-thinking').registration.name, 'conversation.input.model.options')
  assert.equal(byId.get('omni-media').registration.name, 'settings.section')
  assert.equal(byId.get('omni-media').registration.label, '全模态')
  assert.ok(registered.some((entry) =>
    entry.registration.id === 'omni-media'
    && entry.registration.name === 'settings.section.icon'))
  for (const entry of registered) assert.equal(typeof entry.component, 'function')
})
