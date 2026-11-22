import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, LANGUAGE_SKILL } from '../src/language.js'
import { createFakeCtx } from './fake-ctx.mjs'

test('语言优化 Skill 通过 DSH 原生注册表按需加载', async () => {
  const { ctx } = createFakeCtx()
  apply(ctx)
  const skill = await ctx.skills.get(LANGUAGE_SKILL.name)
  assert.equal(skill.name, 'v41pro-language')
  assert.equal(skill.invocation.modelInvocable, true)
  assert.equal(skill.invocation.userInvocable, true)
  assert.match(skill.content, /目标.*交付物.*验收/s)
  assert.match(skill.content, /来源|证据/)
  assert.match(skill.content, /直接|简洁/)
  assert.doesNotMatch(skill.content, /隐藏思维|chain.of.thought/i)
  assert.match(skill.content, /否定.*例外.*失败状态/)
})

test('卸载语言 Skill 后不可继续调用', async () => {
  const fake = createFakeCtx()
  apply(fake.ctx)
  fake.dispose()
  assert.equal(await fake.ctx.skills.get(LANGUAGE_SKILL.name), undefined)
})

test('缺少 skills 服务时明确休眠而不是抛错', () => {
  const { ctx } = createFakeCtx()
  assert.doesNotThrow(() => apply(ctx, { enabled: false }))
})
