/**
 * v41pro 模块共用的落盘工具。
 *
 * 三条约束：
 *  1. 不把插件私有状态写进用户工作目录 —— 默认落在 `$DSH_HOME/v41pro/`。
 *  2. 写入走「临时文件 + rename」，进程被杀不会留下半个 JSON。
 *  3. 每个会话一个文件；跨会话共享的数据用 `GlobalJson`。
 *
 * 路径可以用配置里的 `dir` 覆盖，测试据此指向临时目录。
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** 把任意会话 id 压成安全的文件名。 */
export function safeKey(key) {
  const safe = String(key ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
  return safe || 'session'
}

/** 插件私有根目录；单一入口，避免各模块各写一份 `~/.dsh` 判断。 */
export function v41Dir(...parts) {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'v41pro', ...parts)
}

/** 会话级 JSON 文件：一个 key 一个文件。 */
export class SessionJson {
  constructor(dir, name) {
    this.dir = dir
    this.name = name
  }

  fileFor(key) {
    return path.join(this.dir, `${safeKey(key)}.${this.name}.json`)
  }

  async load(key, fallback) {
    try {
      const raw = await fsp.readFile(this.fileFor(key), 'utf8')
      const data = JSON.parse(raw)
      return data && typeof data === 'object' ? data : fallback
    } catch (error) {
      if (error?.code === 'ENOENT') return fallback
      throw error
    }
  }

  async save(key, data) {
    await fsp.mkdir(this.dir, { recursive: true })
    const file = this.fileFor(key)
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
    await fsp.rename(tmp, file)
  }

  remove(key) {
    try {
      fs.rmSync(this.fileFor(key), { force: true })
    } catch {
      /* ignore */
    }
  }
}

/**
 * 全局 JSON（跨会话共享：规则库、校准记录）。
 * `update(fn)` 串行化读改写，避免并发请求互相覆盖。
 */
export class GlobalJson {
  constructor(dir, name, fallback) {
    this.file = path.join(dir, `${name}.json`)
    this.fallback = fallback
    this.chain = Promise.resolve()
    this.cached = undefined
  }

  async read() {
    if (this.cached !== undefined) return this.cached
    try {
      const raw = await fsp.readFile(this.file, 'utf8')
      const data = JSON.parse(raw)
      this.cached = data && typeof data === 'object' ? data : this.fallback
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      this.cached = this.fallback
    }
    return this.cached
  }

  /**
   * 读改写串行执行；fn 可以同步或异步。
   * @template T
   * @param {(data: any) => T | Promise<T>} fn
   * @returns {Promise<T>}
   */
  update(fn) {
    const run = async () => {
      const data = await this.read()
      const result = await fn(data)
      this.cached = data
      await this.write(data)
      return result
    }
    const next = this.chain.then(run, run)
    this.chain = next.then(() => undefined, () => undefined)
    return next
  }

  async write(data) {
    await fsp.mkdir(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
    await fsp.rename(tmp, this.file)
  }
}

/** 简短、可读、可断言的 id。 */
let counter = 0
export function makeId(prefix = 'id') {
  counter += 1
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`
}
