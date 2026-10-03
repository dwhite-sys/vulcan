// Behavioral host coverage replaces obsolete source-string assertions.
import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, ['../vulcan/terminal_host/test/session.test.mjs'], { cwd: new URL('..', import.meta.url), stdio: 'inherit' });
process.exit(result.status ?? 1);
