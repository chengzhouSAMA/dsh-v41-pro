import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStablePrefix, lintPrefix, PrefixWatch, approxTokens } from '../src/core/stable-prefix.js';

test('稳定块排前、易变块排后，哈希只由稳定块决定', () => {
  const a = buildStablePrefix([{ id: 'b', text: 'B' }, { id: 'a', text: 'A' }, { id: 't', text: 'now', stable: false }]);
  const b = buildStablePrefix([{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }, { id: 't', text: 'later', stable: false }]);
  assert.equal(a.prefix, 'A\n\nB'); assert.equal(a.hash, b.hash);
});
test('lint 发现日期、UUID 等易变内容', () => {
  const w = lintPrefix('今天是 2026-11-22T10:00:00，id 123e4567-e89b-12d3-a456-426614174000');
  assert.equal(w.length, 2);
});
test('PrefixWatch 记录缓存失效', () => {
  const w = new PrefixWatch();
  assert.equal(w.check('h1').changed, false);
  assert.equal(w.check('h1').changed, false);
  assert.equal(w.check('h2').changed, true); assert.equal(w.misses, 1);
});
test('token 估算区分中文与英文', () => {
  assert.equal(approxTokens('你好世界'), 4); assert.equal(approxTokens('abcdefgh'), 2);
});
