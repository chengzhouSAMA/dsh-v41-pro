#!/usr/bin/env node
/**
 * 自检：不启动 harness，只验证本包自身的可装载性。
 *
 *   1. package.json 的每个 exports 都指向真实文件
 *   2. 每个插件模块都导出 name / inject / apply，且没有 default export
 *      （Cordis 的 unwrapExports 会优先取 exports.default，一旦有就会被丢掉命名空间）
 *   3. cordis.patch.yml 能解析，且每一行的 name 都指向本包已导出的子路径
 *
 * 用法：node scripts/selfcheck.mjs
 */

import { Script } from 'node:vm'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 极简 YAML 读取：只认本包 patch 用到的那点结构。 */
function parsePatch(text) {
  const rows = []
  let current = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim() || line.trim().startsWith('#')) continue
    const idMatch = /^\s*-\s+id:\s*(.+)$/.exec(line)
    if (idMatch) {
      current = { id: idMatch[1].trim() }
      rows.push(current)
      continue
    }
    const nameMatch = /^\s+name:\s*['"]?(.+?)['"]?$/.exec(line)
    if (nameMatch && current) {
      current.name = nameMatch[1].trim()
    }
  }
  return rows
}

const failures = []

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const exported = new Map()

for (const [key, pattern] of Object.entries(pkg.exports)) {
  if (key === './package.json') continue
  if (key === './client') {
    new Script(fs.readFileSync(path.join(ROOT, pattern), 'utf8'))
    continue
  }
  if (key.endsWith('/icon')) {
    const file = path.join(ROOT, pattern.replace(/^\.\//, ''))
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) failures.push(`${key} 不是可读资源：${pattern}`)
    else if (!/^\s*<svg\b[\s\S]*<\/svg>\s*$/i.test(fs.readFileSync(file, 'utf8'))) failures.push(`${key} 不是 SVG 图片`)
    continue
  }
  const files = key.includes('*')
    ? fs.readdirSync(path.join(ROOT, path.dirname(pattern)), { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
        .map(entry => path.join(path.dirname(pattern), entry.name))
    : [pattern.replace(/^\.\//, '')]
  if (files.length === 0) failures.push(`exports["${key}"] 没有匹配的资源`)
  for (const rel of files) {
  const file = path.join(ROOT, rel)
  if (rel.endsWith('.json')) {
    try {
      const locale = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!path.basename(rel).startsWith('thinking-ui-') && (typeof locale?.meta?.title !== 'string' || typeof locale?.meta?.description !== 'string')) {
        failures.push(`${rel} 缺少 meta.title / meta.description`)
      }
    } catch (error) {
      failures.push(`${rel} 不是合法 JSON：${error.message}`)
    }
    continue
  }
  if (!fs.existsSync(file)) {
    failures.push(`exports["${key}"] 指向不存在的文件：${rel}`)
    continue
  }
  const module = await import(pathToFileURL(file).href)
  exported.set(key, module)

  if ('default' in module) {
    failures.push(`${key} 有 default export —— Cordis 的 unwrapExports 会因此丢掉 name/apply`)
  }
  if (typeof module.name !== 'string' || !module.name) {
    failures.push(`${key} 缺少导出的 name`)
  }
  if (typeof module.apply !== 'function') {
    failures.push(`${key} 缺少导出的 apply(ctx, config)`)
  }
  if (!Array.isArray(module.inject)) {
    failures.push(`${key} 缺少导出的 inject 数组`)
  }
  }
}

const patch = parsePatch(fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8'))
if (patch.length === 0) failures.push('cordis.patch.yml 里没有解析到任何行')
if (pkg.dsh?.client && !patch.some(row => row.name === pkg.name)) {
  failures.push('Client 模块需要一个裸包名的 patch 入口；仅有子路径不会被 DSH 加载')
}

const specifiers = new Set(Object.keys(pkg.exports)
  .filter(key => key === '.' || !key.includes('*') && key !== './package.json' && key !== './icon')
  .map(key => `${pkg.name}${key.slice(1)}`))
for (const row of patch) {
  if (!row.name) {
    failures.push(`patch 行 ${row.id} 缺少 name`)
    continue
  }
  if (!specifiers.has(row.name)) {
    failures.push(`patch 行 ${row.id} 的 name "${row.name}" 不在 exports 里`)
  }
}

if (failures.length > 0) {
  console.error(`✖ 自检失败（${failures.length} 项）`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}

console.log(`✔ 自检通过：${exported.size} 个导出，${patch.length} 个 patch 行`)
for (const [key, module] of exported) {
  console.log(`  ${key.padEnd(12)} name=${module.name} inject=[${module.inject.join(', ')}]`)
}
