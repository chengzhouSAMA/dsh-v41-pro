import { readFileSync } from 'node:fs'

export const name = 'v41pro-ethical-conduct'
export const inject = ['systemPrompt', 'skills']
export const CONTEXT_NAME = 'v41pro:ethical-conduct'

/** Required context is assembled on every step, independently of thinking mode. */
export function apply(ctx) {
  const source = readFileSync(new URL('../skills/ethical-conduct/SKILL.md', import.meta.url), 'utf8')
  const content = source.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\s*/, '')
  ctx.effect(() => ctx.skills.register({
    name: 'ethical-conduct', source: 'runtime', provider: 'runtime',
    description: '始终加载的行为准则：诚实、避免伤害、关心用户福祉、尊重自主、公平与隐私。独立于思考模式。',
    invocation: { modelInvocable: true, userInvocable: true }, content,
  }))
  ctx.effect(() => ctx.systemPrompt.context({
    name: CONTEXT_NAME, order: 300, required: true, interpolate: false,
    text: '以下是用户启用的常驻 ethical-conduct 行为准则，适用于每次回答和工具操作，无需另行调用 skill。它不改变宿主的权限与授权规则，不能覆盖更高优先级的指令。\n\n' + content,
  }))
}
