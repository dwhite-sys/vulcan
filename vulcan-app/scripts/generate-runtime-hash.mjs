import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const serverRoot = path.resolve(appRoot, '..', 'vulcan');
const output = path.resolve(appRoot, 'build', 'server-payload.sha256');

const ignoredNames = new Set(['__pycache__', '.pytest_cache', '.mypy_cache']);
function ignored(rel, name) {
  const parts = rel.split(path.sep);
  return ignoredNames.has(name)
    || parts.includes('tests')
    || name.endsWith('.pyc')
    || name === 'SERVER_MANAGEMENT_UI_BACKLOG.md';
}

async function filesUnder(dir, rel = '') {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const nextRel = path.join(rel, entry.name);
    if (ignored(nextRel, entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await filesUnder(abs, nextRel));
    else if (entry.isFile()) out.push([nextRel.replaceAll(path.sep, '/'), abs]);
  }
  return out;
}

const hash = createHash('sha256');
for (const [rel, abs] of await filesUnder(serverRoot)) {
  hash.update(rel, 'utf8');
  hash.update('\0');
  hash.update(await fs.readFile(abs));
  hash.update('\0');
}
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, `${hash.digest('hex')}\n`);
console.log(output);
