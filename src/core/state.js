/**
 * 按 Agent 分桶的内存状态。
 *
 * 用 WeakMap：agent 被销毁时状态自动回收，不需要 disposer 也能不泄漏。
 * 同一 agent 的生命周期内状态跨 turn 保留 —— 这正是「长程记忆」要的。
 */

/**
 * @template T
 * @param {(agent: object) => T} factory
 */
export function createAgentStore(factory) {
  /** @type {WeakMap<object, T>} */
  const map = new WeakMap()
  return {
    /**
     * 取（必要时创建）该 agent 的状态。
     * @param {object} agent
     * @returns {T}
     */
    get(agent) {
      let state = map.get(agent)
      if (state === undefined) {
        state = factory(agent)
        map.set(agent, state)
      }
      return state
    },
    /** 只读探测，不存在时返回 undefined（不会创建）。 */
    peek(agent) {
      return map.get(agent)
    },
    /** 丢弃状态。 */
    delete(agent) {
      map.delete(agent)
    },
  }
}

/**
 * 取会话的稳定标识。优先 session.id；退化到对象身份，保证同进程内唯一。
 * @param {any} agent
 */
export function sessionKey(agent) {
  const id = agent?.session?.id
  if (typeof id === 'string' && id) return id
  if (id !== undefined && id !== null) return String(id)
  return ''
}

/**
 * 有界队列：只保留最近 max 条。内容都是短字符串/小对象。
 * @template T
 * @param {number} max
 */
export function boundedPush(list, item, max) {
  list.push(item)
  if (list.length > max) list.splice(0, list.length - max)
  return list
}
