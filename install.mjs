#!/usr/bin/env node
/**
 * 把伪·V4.1 Pro 挂进一个 dsh profile。
 *
 * 做的事只有两件，都可逆：
 *   1. 在 profile 的 package.json 里加一条 `"dsh-v41-pro": "link:<本包目录>"`
 *   2. 在 `dsh.profile.bundles` 数组里加 `"dsh-v41-pro"`
 *
 * 不改 cordis.patch.yml —— bundle 自带的那一份会在 profile 层之前生效，
 * 用户自己的 patch 仍然可以用同一个 id 覆盖任意一行。
 *
 * 用法：
 *   node install.mjs                       # 自动挑 profile，只改文件
 *   node install.mjs --profile web-desktop # 指定 profile
 *   node install.mjs --install             # 改完顺手跑 pnpm install
 *   node install.mjs --dry-run             # 只打印要改什么
 *   node install.mjs --uninstall           # 撤掉链接与 bundle 条目
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PACKAGE_NAME = 'dsh-v41-pro'
const SELF_DIR = path.dirname(fileURLToPath(import.meta.url))

/** 带值的参数。 */
function argValue(argv, flag) {
  const index = argv.indexOf(flag)
  return index >= 0 ? argv[index + 1] : undefined
}

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const uninstall = argv.includes('--uninstall')
const runInstall = argv.includes('--install')
const explicitProfile = argValue(argv, '--profile')

const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const profilesDir = path.join(dshHome, 'profiles')

/** 列出所有带 package.json 的 profile。 */
function listProfiles() {
  if (!fs.existsSync(profilesDir)) return []
  return fs.readdirSync(profilesDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(name => fs.existsSync(path.join(profilesDir, name, 'package.json')))
}

/** 若没有指定，按桌面 → web → web-desktop → 第一个 的顺序挑。 */
function pickProfile(profiles) {
  for (const candidate of ['desktop', 'web-desktop', 'web']) {
    if (profiles.includes(candidate)) return candidate
  }
  return profiles[0]
}

function linkSpec() {
  // pnpm 的 link: 协议接受正斜杠路径；Windows 反斜杠在 YAML/JSON 里会被转义。
  return `link:${SELF_DIR.replaceAll('\\', '/')}`
}

function main() {
  const profiles = listProfiles()
  if (profiles.length === 0) {
    fail(`没有在 ${profilesDir} 下找到任何 profile。先跑一次 dsh，让它生成默认 profile。`)
  }

  const profileName = explicitProfile ?? pickProfile(profiles)
  if (!profiles.includes(profileName)) {
    fail(`profile "${profileName}" 不存在。可用的：${profiles.join(', ')}`)
  }

  const profileDir = path.join(profilesDir, profileName)
  const manifestPath = path.join(profileDir, 'package.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

  manifest.dependencies = manifest.dependencies ?? {}
  manifest.dsh = manifest.dsh ?? {}
  manifest.dsh.profile = manifest.dsh.profile ?? {}
  const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []
  manifest.dsh.profile.bundles = bundles

  if (uninstall) {
    delete manifest.dependencies[PACKAGE_NAME]
    manifest.dsh.profile.bundles = bundles.filter(name => name !== PACKAGE_NAME)
  } else {
    manifest.dependencies[PACKAGE_NAME] = linkSpec()
    if (!manifest.dsh.profile.bundles.includes(PACKAGE_NAME)) {
      manifest.dsh.profile.bundles.push(PACKAGE_NAME)
    }
  }

  const serialized = `${JSON.stringify(manifest, null, 2)}\n`

  console.log(`profile: ${profileName}`)
  console.log(`路径:    ${profileDir}`)
  console.log('')
  console.log(serialized)

  if (dryRun) {
    console.log('（--dry-run，未写入）')
    return
  }

  const backup = `${manifestPath}.bak-v41pro-${stamp()}`
  fs.copyFileSync(manifestPath, backup)
  fs.writeFileSync(manifestPath, serialized, 'utf8')
  console.log(`已写入。备份：${path.basename(backup)}`)

  if (runInstall) {
    console.log('')
    console.log('运行 pnpm install …')
    const result = spawnSync('pnpm', ['install'], { cwd: profileDir, stdio: 'inherit', shell: true })
    if (result.status !== 0) {
      fail('pnpm install 失败。修好之后重跑 install.mjs --install，或手动在 profile 目录执行 pnpm install。')
    }
  } else {
    console.log('')
    console.log('下一步：在该 profile 目录执行 pnpm install')
    console.log(`  cd "${profileDir}" && pnpm install`)
    console.log('然后重启 dsh。')
  }
}

function stamp() {
  const now = new Date()
  const pad = value => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

function fail(message) {
  console.error(`✖ ${message}`)
  process.exit(1)
}

main()
