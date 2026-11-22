#!/usr/bin/env node
// 用法：node scripts/rename.mjs dsh-v41-pro=dsh-evidence-loop v41pro=evidenceloop [--write]
// 默认只预览。改名后旧状态目录需迁移：见 src/core/migrate.mjs。
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const write = args.includes('--write');
const pairs = args.filter((a) => a.includes('=')).map((a) => a.split('='));
if (!pairs.length) { console.error('需要至少一个 old=new'); process.exit(1); }
const SKIP = new Set(['.git', 'node_modules']);
const EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.yml', '.yaml', '.md', '.ps1', '.txt']);

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (EXT.has(path.extname(e.name)) && e.name !== 'pnpm-lock.yaml') yield p;
  }
}

let total = 0;
for (const f of walk(process.cwd())) {
  let s = fs.readFileSync(f, 'utf8'); const orig = s; let n = 0;
  for (const [o, nw] of pairs) { const parts = s.split(o); n += parts.length - 1; s = parts.join(nw); }
  if (n) { total += n; console.log(`${write ? '改' : '将改'} ${path.relative(process.cwd(), f)}: ${n} 处`); if (write && s !== orig) fs.writeFileSync(f, s); }
}
console.log(`共 ${total} 处${write ? '已替换' : '（预览，加 --write 才会写入）'}`);
