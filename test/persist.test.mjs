import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { SessionJson, GlobalJson, safeKey, makeId } from '../src/core/persist.js'

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'v41pro-persist-'))
}

test('SessionJson 按 key 落盘、重载与删除', async () => {
  const dir = tempDir()
  try {
    const store = new SessionJson(dir, 'demo')
    assert.deepEqual(await store.load('session/1', { empty: true }), { empty: true })
    await store.save('session/1', { n: 1 })
    assert.deepEqual(await store.load('session/1', {}), { n: 1 })
    assert.match(store.fileFor('session/1'), /session_1\.demo\.json$/)
    store.remove('session/1')
    assert.deepEqual(await store.load('session/1', { empty: true }), { empty: true })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('GlobalJson 串行读改写，不丢并发更新', async () => {
  const dir = tempDir()
  try {
    const store = new GlobalJson(dir, 'rules', { version: 1, rules: [] })
    await Promise.all([
      store.update(data => { data.rules.push({ id: 'a' }) }),
      store.update(data => { data.rules.push({ id: 'b' }) }),
      store.update(data => { data.rules.push({ id: 'c' }) }),
    ])
    const data = JSON.parse(fs.readFileSync(path.join(dir, 'rules.json'), 'utf8'))
    assert.deepEqual(data.rules.map(rule => rule.id), ['a', 'b', 'c'])

    const reloaded = new GlobalJson(dir, 'rules', { version: 1, rules: [] })
    const again = await reloaded.update(current => current.rules.length)
    assert.equal(again, 3)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('safeKey 只留安全字符，且不会为空', () => {
  assert.equal(safeKey('a/b\\c:d'), 'a_b_c_d')
  assert.equal(safeKey(''), 'session')
  assert.ok(safeKey('x'.repeat(300)).length <= 120)
})

test('makeId 带前缀且单调不重复', () => {
  const ids = new Set(Array.from({ length: 20 }, () => makeId('rule')))
  assert.equal(ids.size, 20)
  for (const id of ids) assert.match(id, /^rule-/)
})
