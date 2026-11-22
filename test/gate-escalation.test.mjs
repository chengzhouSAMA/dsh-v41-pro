import test from 'node:test';
import assert from 'node:assert/strict';
import { GateTracker, isPerfunctory, auditShrinkDecisions } from '../src/core/gate-escalation.js';

test('三次无进展：steer → steer-strong → 未验证横幅', () => {
  const g = new GateTracker();
  const p = { pending: ['跑测试'] };
  assert.equal(g.next('acceptance', p).action, 'steer');
  assert.equal(g.next('acceptance', p).action, 'steer-strong');
  const last = g.next('acceptance', p);
  assert.equal(last.action, 'report-unverified'); assert.match(last.banner, /未验证/);
  assert.deepEqual(g.summary(), [{ gate: 'acceptance', dismissed: 1 }]);
});
test('没有待办直接通过并清状态', () => {
  const g = new GateTracker();
  g.next('acceptance', { pending: ['x'] });
  assert.equal(g.next('acceptance', { pending: [] }).action, 'pass');
  assert.equal(g.next('acceptance', { pending: ['x'] }).action, 'steer');
});
test('有进展不被升级', () => {
  const g = new GateTracker();
  g.next('acceptance', { pending: ['a', 'b'] });
  assert.equal(g.next('acceptance', { pending: ['b'], progress: true }).action, 'steer');
});
test('敷衍理由识别', () => {
  assert.equal(isPerfunctory('保留'), true);
  assert.equal(isPerfunctory('keep, looks good'), true);
  assert.equal(isPerfunctory('合并进 utils.js：两处函数逻辑完全相同，合并后少 40 行'), false);
});
test('审计：重复理由与敷衍理由', () => {
  const a = auditShrinkDecisions([
    { file: 'a.js', action: 'keep', reason: 'fine' },
    { file: 'b.js', action: 'keep', reason: '核心逻辑，被三个模块引用，不能删除' },
    { file: 'c.js', action: 'keep', reason: '核心逻辑，被三个模块引用，不能删除' },
  ]);
  assert.deepEqual(a.perfunctory, ['a.js']); assert.deepEqual(a.duplicates.sort(), ['b.js', 'c.js']); assert.equal(a.ok, false);
});
