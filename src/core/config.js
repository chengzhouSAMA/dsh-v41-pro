/**
 * 配置归一化。
 *
 * 设计取舍：这里**不抛异常**。harness 的包内插件用 schemastery 做 fail-loud
 * 校验，但外置 bundle 一旦在 apply 里抛错就整行停用，用户只会看到「插件没生
 * 效」而拿不到原因。所以非法值一律回落到默认值并记一条警告。
 */

/** 把任意值收敛成有限数。 */
export function num(value, fallback, { min = -Infinity, max = Infinity, integer = true } = {}) {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback
  if (integer && !Number.isInteger(parsed)) return fallback
  if (parsed < min || parsed > max) return fallback
  return parsed
}

/** 把任意值收敛成字符串。 */
export function str(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

/** 把任意值收敛成布尔。 */
export function bool(value, fallback = false) {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

/** 把任意值收敛成字符串数组（过滤非字符串项）。 */
export function strList(value, fallback = []) {
  if (!Array.isArray(value)) return fallback
  const list = value.filter(item => typeof item === 'string' && item.trim() !== '')
  return list.length > 0 ? list : fallback
}

/** 取一个带前缀的日志器；ctx.logger 不存在时静默。 */
export function makeLogger(ctx, scope) {
  const logger = ctx?.logger
  const prefix = `[${scope}]`
  const emit = (level, ...args) => {
    try {
      if (logger && typeof logger[level] === 'function') logger[level](prefix, ...args)
    } catch {
      /* 日志本身永远不能让插件挂掉 */
    }
  }
  return {
    debug: (...args) => emit('debug', ...args),
    info: (...args) => emit('info', ...args),
    warn: (...args) => emit('warn', ...args),
    error: (...args) => emit('error', ...args),
  }
}

/**
 * 语言化文案选择。
 * @param {string} language
 * @param {{ zh: unknown, en: unknown }} table
 */
export function pickLanguage(language, table) {
  return language === 'en' ? table.en : table.zh
}
