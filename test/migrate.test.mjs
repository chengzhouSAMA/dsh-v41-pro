import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { migrateStateDir } from '../src/core/migrate.js';

test('迁移旧状态目录，且不覆盖已有新目录', () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-'));
  fs.mkdirSync(path.join(h, 'v41pro')); fs.writeFileSync(path.join(h, 'v41pro', 'a.json'), '{}');
  assert.equal(migrateStateDir(h, 'v41pro', 'evidenceloop'), true);
  assert.ok(fs.existsSync(path.join(h, 'evidenceloop', 'a.json')));
  fs.mkdirSync(path.join(h, 'old2'));
  assert.equal(migrateStateDir(h, 'old2', 'evidenceloop'), false);
});
