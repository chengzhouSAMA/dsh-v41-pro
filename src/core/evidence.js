/**
 * 可执行证据：进程退出状态、测试摘要、稳定失败指纹与落盘脱敏。
 * 只使用 Node 内置模块，不信任模型对命令结果的自我描述。
 */

import { createHash } from 'node:crypto'
import { blocksToText, canonicalize, truncate } from './util.js'

/** 对写入持久台账的文本做最小必要脱敏。 */
export function redactSecrets(value) {
  return String(value ?? '')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|key|token|secret|password|passwd|api[_-]?key)[-_][A-Za-z0-9._-]{6,}\b/gi, '[redacted]')
    .replace(/([?&](?:access_)?(?:api[_-]?key|token|secret|password)=)[^\s&]+/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|token|secret|password|passwd)\s*[:=]\s*["']?)[^\s"']+/gi, '$1[redacted]')
}

/** 从工具的结构化值/元数据中寻找 shell 的真实状态。 */
function statusOf(result) {
  const roots = [result?.value, result?.meta]
  for (const root of roots) {
    if (!root || typeof root !== 'object' || Array.isArray(root)) continue
    const exitCode = typeof root.exitCode === 'number' ? root.exitCode : null
    if (exitCode !== null || root.timedOut === true || root.aborted === true || root.stopped !== undefined) {
      return {
        exitCode,
        invalid: root.timedOut === true || root.aborted === true || root.stopped !== undefined
          || root.signal !== null && root.signal !== undefined
          || root.sandbox?.denied === true || root.sandbox?.runnerFailed === true,
      }
    }
  }
  return null
}

/** 提取不依赖具体测试框架的进程/输出状态。 */
function outputAssessment(result) {
  if (result?.isError === true) return { ok: false, exitCode: null, reason: 'tool-error' }
  const text = blocksToText(result?.content)
  const structured = statusOf(result)
  const marker = /^\[exit code:\s*(-?\d+)\][^\n]*$/gim.exec(text)
  const markerExit = marker ? Number(marker[1]) : null
  if (structured && markerExit !== null && structured.exitCode !== markerExit) {
    return { ok: false, exitCode: structured.exitCode ?? markerExit, reason: 'conflicting-evidence' }
  }
  if (structured?.invalid || /^\[(?:timed out|stopped:|killed by signal:|still running |sandbox:)/im.test(text)) {
    return { ok: false, exitCode: structured?.exitCode ?? markerExit, reason: 'incomplete' }
  }
  const exitCode = structured?.exitCode ?? markerExit
  if (exitCode !== null && exitCode !== 0) return { ok: false, exitCode, reason: 'exit-code' }
  return { ok: true, exitCode, reason: 'ok', text }
}

/** 这条命令是否必须给出可识别的测试执行摘要。 */
export function requiresTestEvidence(command) {
  const text = String(command ?? '')
  return /(?:\bnode\s+[^\n;&|]*--test\b|\b(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b|\bpytest\b|\bvitest\b|\bjest\b|\bgo\s+test\b|\bcargo\s+test\b|\b(?:dotnet|mvn|gradle)\s+test\b|\bpython\s+-m\s+unittest\b|\bmake\s+test\b)/i.test(text)
}

/**
 * 识别常见测试框架的摘要。空测试、失败/取消、只有收集没有执行都不能放行。
 * 编译/lint 不需要测试摘要，但仍由退出码决定。
 */
export function assessTestSummary(text) {
  const output = String(text ?? '')
  if (/\b(?:no tests? (?:ran|found|files found)|no test files found|collected 0 items|empty test suite)\b/i.test(output)
    || /\b0\s+(?:tests?|passed)\b/i.test(output) || /\bRan 0 tests\b/i.test(output)) {
    return { ok: false, recognized: true, reason: 'no-tests' }
  }

  const nodeCount = /^\s*(?:ℹ\s+)?tests\s+(\d+)\s*$/im.exec(output)
  const nodePass = /^\s*(?:ℹ\s+)?pass\s+(\d+)\s*$/im.exec(output)
  const nodeFail = /^\s*(?:ℹ\s+)?fail\s+(\d+)\s*$/im.exec(output)
  const nodeCancelled = /^\s*(?:ℹ\s+)?cancelled\s+(\d+)\s*$/im.exec(output)
  if (nodeCount || nodePass || nodeFail) {
    const total = Number(nodeCount?.[1] ?? 0)
    const passed = Number(nodePass?.[1] ?? 0)
    const failed = Number(nodeFail?.[1] ?? 0) + Number(nodeCancelled?.[1] ?? 0)
    if (total === 0 || passed === 0) return { ok: false, recognized: true, reason: 'no-tests' }
    if (failed > 0) return { ok: false, recognized: true, reason: 'failed-tests' }
    return { ok: true, recognized: true, reason: 'ok' }
  }

  if (/\bTests:\s*/i.test(output)) {
    const line = /^\s*Tests:\s*([^\r\n]+)/im.exec(output)?.[1] ?? ''
    const total = /(\d+)\s+total\b/i.exec(line)
    const passed = /(\d+)\s+passed\b/i.exec(line)
    const failures = /(\d+)\s+failed\b/i.exec(line)
    if (failures && Number(failures[1]) > 0) return { ok: false, recognized: true, reason: 'failed-tests' }
    if (!total || Number(total[1]) === 0 || !passed || Number(passed[1]) === 0) {
      return { ok: false, recognized: true, reason: 'no-tests' }
    }
    return { ok: true, recognized: true, reason: 'ok' }
  }

  const pytest = /(\d+)\s+passed\b/i.exec(output)
  const pytestFailed = /(\d+)\s+(?:failed|errors?)\b/i.exec(output)
  if (pytest || pytestFailed) {
    if (pytestFailed && Number(pytestFailed[1]) > 0) return { ok: false, recognized: true, reason: 'failed-tests' }
    if (!pytest || Number(pytest[1]) === 0) return { ok: false, recognized: true, reason: 'no-tests' }
    return { ok: true, recognized: true, reason: 'ok' }
  }

  if (/^\s*not ok\b/im.test(output)) return { ok: false, recognized: true, reason: 'failed-tests' }
  const tap = /^\s*1\.\.(\d+)\s*$/im.exec(output)
  if (tap) return Number(tap[1]) > 0
    ? { ok: true, recognized: true, reason: 'ok' }
    : { ok: false, recognized: true, reason: 'no-tests' }
  if (/^\s*ok\s+\S+\s+\d+(?:\.\d+)?s\b/im.test(output)) return { ok: true, recognized: true, reason: 'ok' }
  return { ok: false, recognized: false, reason: 'missing-evidence' }
}

/** 综合实际进程状态与必要的测试摘要。 */
export function assessCommandResult(result, { requireSummary = false } = {}) {
  const process = outputAssessment(result)
  if (!process.ok) return { ok: false, exitCode: process.exitCode, reason: process.reason }
  if (!requireSummary) return { ok: true, exitCode: process.exitCode, reason: 'ok' }
  const summary = assessTestSummary(process.text)
  return {
    ok: summary.ok,
    exitCode: process.exitCode,
    reason: summary.reason,
    recognized: summary.recognized,
  }
}

/** 失败指纹用于识别跨成功读取/搜索之后再次出现的同一问题。 */
export function failureFingerprint(exec, result) {
  const tool = String(exec?.name ?? '')
  const args = canonicalize(redactValue(exec?.arguments))
  const category = outputAssessment(result).reason
  const rawMessage = result?.error?.message ?? blocksToText(result?.content)
  const message = redactSecrets(rawMessage)
    .replace(/(?:[A-Za-z]:)?(?:[\\/][^\s:'"()]+)+/g, '<path>')
    .replace(/\b\d+(?:\.\d+)?\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)
  return createHash('sha256').update(`${tool}\0${args}\0${category}\0${message}`).digest('hex').slice(0, 20)
}

/** 从结果里提取可落盘的短错误；非零退出也保留实际输出尾部。 */
export function failureSummary(result, max = 160) {
  const text = result?.error?.message ?? blocksToText(result?.content) ?? '失败'
  return truncate(redactSecrets(text).replace(/\s+/g, ' ').trim() || '失败', max)
}

function redactValue(value, seen = new Set(), depth = 0) {
  if (typeof value === 'string') return redactSecrets(value)
  if (value === null || typeof value !== 'object') return value
  if (depth >= 8 || seen.has(value)) return '[truncated]'
  seen.add(value)
  if (Array.isArray(value)) return value.slice(0, 100).map(item => redactValue(item, seen, depth + 1))
  const output = {}
  for (const key of Object.keys(value).slice(0, 100)) output[key] = redactValue(value[key], seen, depth + 1)
  return output
}
