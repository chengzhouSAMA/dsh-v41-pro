// 改名后在插件启动时调用一次：把 $DSH_HOME/<旧名> 迁移到 $DSH_HOME/<新名>
import fs from 'node:fs';
import path from 'node:path';

export function migrateStateDir(home, oldName, newName) {
  const o = path.join(home, oldName), n = path.join(home, newName);
  if (fs.existsSync(o) && !fs.existsSync(n)) { fs.renameSync(o, n); return true; }
  return false;
}
