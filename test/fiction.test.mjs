import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, FICTION_SKILL } from '../src/fiction.js'
import { createFakeCtx } from './fake-ctx.mjs'

test('文学 Skill 覆盖本次两篇正文暴露的规则依据与章末焦点问题', async () => {
  const fake = createFakeCtx()
  apply(fake.ctx)
  const skill = await fake.ctx.skills.get(FICTION_SKILL.name)
  assert.equal(skill.name, 'v41pro-fiction')
  assert.equal(skill.invocation.modelInvocable, true)
  assert.match(skill.content, /角色知识边界.*依据/s)
  assert.match(skill.content, /未经证据.*解释机制/s)
  assert.match(skill.content, /核心异常|核心意象/)
  assert.match(skill.content, /章末.*一个|一个.*章末/s)
  assert.match(skill.content, /题材|语气|年代/)
  assert.match(skill.content, /重复赶场|拖延节奏/)
  assert.match(skill.content, /对话.*动作|动作.*对话/s)
  assert.match(skill.content, /不要.*解释|只输出/s)
})

test('文学 Skill v2 覆盖主动选择、数字可验证与事故伏笔', async () => {
  const fake = createFakeCtx()
  apply(fake.ctx)
  const skill = await fake.ctx.skills.get(FICTION_SKILL.name)
  assert.match(skill.content, /有代价.*改变下一章|改变下一章.*有代价/s)
  assert.match(skill.content, /数字.*可验证|可验证.*数字|数字.*证据/s)
  assert.match(skill.content, /伏笔.*事故|事故.*伏笔|因果.*伏笔/s)
  assert.match(skill.content, /禁止.*巧合|巧合.*禁止|孤立.*巧合/s)
  assert.match(skill.content, /主动选择|主动决定/)
  assert.match(skill.content, /角色猜测|猜测|不确定/s)
})

test('文学 Skill v3 要求交叉验证、NPC 阻力和篇幅验收', async () => {
  const fake = createFakeCtx()
  apply(fake.ctx)
  const skill = await fake.ctx.skills.get(FICTION_SKILL.name)
  assert.match(skill.content, /交叉验证|独立证据|第二次验证/)
  assert.match(skill.content, /NPC.*包办|包办.*NPC|NPC.*阻力/)
  assert.match(skill.content, /篇幅.*验收|验收.*篇幅/)
  assert.match(skill.content, /阻力.*主动|主动.*阻力/)
  assert.match(skill.content, /追求关系|关系.*改变|代价.*关系/)
  assert.match(skill.content, /配角|对手|反派/)
})

test('文学 Skill 不声称超越任何模型', async () => {
  const fake = createFakeCtx()
  apply(fake.ctx)
  const skill = await fake.ctx.skills.get(FICTION_SKILL.name)
  assert.doesNotMatch(skill.content, /超越.{0,8}(?:V4|v4|模型)|保证.{0,10}(?:提升|提高|超过|优于|更好)/s)
})

test('文学 Skill 可卸载，关闭时不注册', async () => {
  const fake = createFakeCtx()
  apply(fake.ctx)
  fake.dispose()
  assert.equal(await fake.ctx.skills.get(FICTION_SKILL.name), undefined)
  const disabled = createFakeCtx()
  apply(disabled.ctx, { enabled: false })
  assert.equal(await disabled.ctx.skills.get(FICTION_SKILL.name), undefined)
})
