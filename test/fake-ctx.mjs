/**
 * 一个最小的 cordis Context 替身，只实现本包用到的表面：
 *   ctx.on / ctx.effect / ctx.tools.register / ctx.logger / ctx.shell / ctx.llm / ctx.subagents
 *
 * waterfall 的组合顺序与 cordis 一致：先注册的在最外层，`next()` 向内传递。
 *
 * 契约基线：deepseek-harness 0.2.2-rc.3。
 */

export function createFakeCtx({ shell, llm, logger, subagents, skills } = {}) {
  /** @type {Map<string, Function[]>} */
  const handlers = new Map()
  /** @type {Map<string, any>} */
  const tools = new Map()
  const commands = new Map()
  const runtimeSkills = new Map()
  const disposers = []

  const ctx = {
    logger,
    shell,
    llm,
    subagents,
    skills: skills ?? {
      register(skill) {
        runtimeSkills.set(skill.name, skill)
        return () => runtimeSkills.delete(skill.name)
      },
      async get(skillName) {
        return runtimeSkills.get(skillName)
      },
    },
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(handler)
      return () => {
        const list = handlers.get(event) ?? []
        const index = list.indexOf(handler)
        if (index >= 0) list.splice(index, 1)
      }
    },
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    commands: {
      register(definition) {
        commands.set(definition.name, definition)
        return () => commands.delete(definition.name)
      },
    },
  }

  /**
   * cordis Context#get：按服务名取已注入的服务，缺失时返回 undefined。
   * omni 用 `ctx.get('skills')` / `ctx.get('webServer')` 做可选能力探测，
   * 替身不实现它，「可选注册」就永远走不到。
   * @param {string} service
   */
  ctx.get = (service) => {
    if (service === 'skills') return ctx.skills
    if (service === 'shell') return ctx.shell
    if (service === 'llm') return ctx.llm
    if (service === 'subagents') return ctx.subagents
    if (service === 'commands') return ctx.commands
    return undefined
  }

  /**
   * 调用一串 waterfall 监听器。
   * @param {string} event
   * @param {unknown[]} args 除 next 以外的参数
   * @param {unknown} base 终端决策
   */
  async function call(event, args, base) {
    const list = handlers.get(event) ?? []
    let next = async () => base
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const handler = list[index]
      const inner = next
      next = () => handler(...args, inner)
    }
    return next()
  }

  /** 调用一串 emit/serial 监听器。 */
  function emit(event, payload) {
    const list = handlers.get(event) ?? []
    return list.map(handler => handler(payload))
  }

  // 测试辅助直接挂在 ctx 上，省得每个 helper 都要多收一个参数。
  // 真实 ctx 没有这两个方法，插件代码也从不使用它们。
  ctx.call = call
  ctx.emit = emit

  return {
    ctx,
    call,
    emit,
    handlers,
    tool(name) {
      return tools.get(name)
    },
    toolCount() {
      return tools.size
    },
    command(name) {
      return commands.get(name)
    },
    dispose() {
      for (const disposer of disposers.splice(0).reverse()) disposer()
    },
  }
}

/**
 * 造一个子代理服务替身（0.2.2-rc.3 的 `startActivation` 形状）。
 * @param {(request: any, index: number) => string} responder 每次 start 返回的子代理输出文本
 */
export function createFakeSubagents(responder) {
  const starts = []
  let disposed = 0
  return {
    starts,
    get disposed() {
      return disposed
    },
    /** rc.3 的 getProvider；默认返回支持 agentOptions 的 spawn 能力。 */
    getProvider() {
      return {
        name: 'spawn',
        capabilities: { agentOptions: true, agentPreset: true, outputSchema: true, depthLimit: true },
        inheritsParentContext: false,
      }
    },
    async startActivation(spec) {
      starts.push({ spec, request: spec })
      const index = starts.length
      const output = typeof responder === 'function' ? responder(spec, index) : String(responder ?? '')
      return {
        childId: `child-${index}`,
        name: spec.name ?? `agent-${index}`,
        messageId: undefined,
        result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: output }] }),
        async dispose() {
          disposed += 1
        },
      }
    },
  }
}

/**
 * 造一个 agent 替身。
 *
 * 0.2.2-rc.3 起模型选择是 `agent.model.select()` 的持久化选择（不再有
 * `agent/request` 事件），所以替身必须带一个可观测的 model 对象。
 */
export function createFakeAgent(id = 'session-1', selection = { provider: 'deepseek-official', model: 'deepseek-flash' }) {
  const steered = []
  const selections = []
  let current = selection
  return {
    session: { id },
    steered,
    selections,
    get currentSelection() {
      return current
    },
    model: {
      current() {
        return current === undefined ? undefined : { ...current }
      },
      select(next) {
        selections.push({ ...next })
        current = { ...next }
      },
    },
    steer(message) {
      steered.push(message)
    },
  }
}

/** 造一次工具执行。 */
export function createToolExec({ name = 'bash', args = {}, agent }) {
  return { name, arguments: args, agent }
}

/** 成功的工具结果。 */
export const OK_RESULT = { isError: false, content: [], value: null }

/** 失败的工具结果。 */
export function failResult(message = 'boom') {
  return { isError: true, content: [], error: { message } }
}
