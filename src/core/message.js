/**
 * 注入消息的构造。
 *
 * harness 的 createUserMessage 等价于：
 *   deepFreeze(structuredClone({ ...input, id: randomUUID(), role: 'user' }))
 * 这里逐字复刻该语义，避免依赖 @deepseek-ai/dsh-llm —— 外置 bundle 拿不到
 * 工作区内的 workspace 依赖。
 *
 * source.kind 必须是「生产者自有」的非空字符串且不能是字面量 'plugin'
 * （见 session-format-v3-to-v4/message-sources.ts 的准入检查）。自定义 kind
 * 会被原样保留：归档层不认得它，但也不会拒绝。
 */

import { randomUUID } from 'node:crypto'
import { deepFreeze } from './util.js'

/** harness 对 notice 摘要的硬上限。 */
export const CONTEXT_SUMMARY_MAX_CHARS = 120

/** 把一行摘要压到 harness 的 notice 上限内。 */
export function boundSummary(text) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length <= CONTEXT_SUMMARY_MAX_CHARS
    ? value
    : `${value.slice(0, CONTEXT_SUMMARY_MAX_CHARS - 1)}…`
}

/**
 * 构造一条模型可见的 user-role 注入消息。
 * @param {{ text: string, source: Record<string, unknown> }} input
 * @returns {object} 冻结的 UserMessage 结构
 */
export function createInjectedMessage({ text, source }) {
  return deepFreeze(structuredClone({
    role: 'user',
    content: [{ type: 'text', text }],
    source,
    id: randomUUID(),
  }))
}

/**
 * 构造一条 `notice` 形态的注入消息（一次性事件：升级、提醒、交接）。
 * @param {{ text: string, kind: string, summary: string, extra?: Record<string, unknown> }} input
 */
export function createNotice({ text, kind, summary, extra }) {
  return createInjectedMessage({
    text,
    source: { kind, form: 'notice', summary: boundSummary(summary), ...(extra ?? {}) },
  })
}

/**
 * 构造一条 `snapshot` 形态的注入消息（当前状态：台账卡）。
 * snapshot 语义 = 后一份快照取代前一份，适合定期重注入的现状。
 * @param {{ text: string, kind: string, sections: Array<{ name: string, text: string }>, extra?: Record<string, unknown> }} input
 */
export function createSnapshot({ text, kind, sections, extra }) {
  return createInjectedMessage({
    text,
    source: {
      kind,
      form: 'snapshot',
      sections: sections.map(section => ({ name: section.name, text: section.text })),
      ...(extra ?? {}),
    },
  })
}
