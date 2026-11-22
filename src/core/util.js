/**
 * 纯工具函数：不 import 任何 @deepseek-ai/* 包。
 *
 * 外置 bundle 的硬约束：只能依赖 Node 内置模块。所有与 harness 的交互都走
 * 运行期传入的 ctx 对象和消息的字面结构，不做 build，不做类型导入。
 */

/** 深排序 JSON 值，让仅属性顺序不同的两个参数对象规范化成同一字符串。 */
function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (value !== null && typeof value === 'object') {
    const record = /** @type {Record<string, unknown>} */ (value)
    /** @type {Record<string, unknown>} */
    const sorted = {}
    for (const key of Object.keys(record).sort()) sorted[key] = sortJsonValue(record[key])
    return sorted
  }
  return value
}

/** 稳定序列化：深排序 + JSON.stringify；无法序列化时退化为 String()。 */
export function canonicalize(value) {
  try {
    return JSON.stringify(sortJsonValue(value)) ?? ''
  } catch {
    return String(value)
  }
}

/** 截断到 max 字符，超出时标注省略了多少。 */
export function truncate(text, max) {
  const value = String(text ?? '')
  if (value.length <= max) return value
  return `${value.slice(0, max)}… (+${value.length - max} chars)`
}

/** 从 {type:'text', text} 块数组里拼出纯文本。 */
export function blocksToText(content) {
  if (!Array.isArray(content)) return ''
  /** @type {string[]} */
  const parts = []
  for (const block of content) {
    if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

const PATH_KEYS = [
  'path', 'file_path', 'filePath', 'file', 'filename', 'target_file', 'notebook_path', 'target',
]

/** 从工具参数里尽力取出被操作的文件路径；取不到返回空串。 */
export function extractPath(args) {
  if (!args || typeof args !== 'object') return ''
  for (const key of PATH_KEYS) {
    const value = /** @type {Record<string, unknown>} */ (args)[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

/** 从工具参数里尽力取出被执行的命令文本。 */
export function extractCommand(args) {
  if (!args || typeof args !== 'object') return ''
  const record = /** @type {Record<string, unknown>} */ (args)
  for (const key of ['command', 'cmd', 'script', 'shell_command']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

/** 编译一个 `*` 通配模式为锚定正则；其余正则元字符按字面量处理。 */
export function wildcardToRegExp(pattern) {
  const escaped = String(pattern).replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`)
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`)
}

/** 深冻结，与 harness 的 createMessage 保持同样的不可变性契约。 */
export function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const key of Object.keys(value)) deepFreeze(/** @type {any} */ (value)[key])
  return Object.freeze(value)
}

/**
 * 安全执行：监听器里的任何异常都不允许逃逸到 agent loop。
 * @template T
 * @param {() => T} fn
 * @param {(error: unknown) => void} [onError]
 * @returns {T | undefined}
 */
export function safe(fn, onError) {
  try {
    return fn()
  } catch (error) {
    try {
      onError?.(error)
    } catch {
      /* 记录失败也不能再抛 */
    }
    return undefined
  }
}

/** 单调递增的进程内计数器。 */
let sequence = 0

/** 返回一个进程内唯一的短标识。 */
export function nextSeq() {
  sequence += 1
  return sequence
}
