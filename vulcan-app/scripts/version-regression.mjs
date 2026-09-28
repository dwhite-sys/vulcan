import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');

const readJson = (name) => JSON.parse(fs.readFileSync(path.join(appDir, name), 'utf8'));
const pkg = readJson('package.json');
const lock = readJson('package-lock.json');

const version = String(pkg.version || '').trim();
if (!version) throw new Error('vulcan-app/package.json is missing its version');

// package.json is the runtime/build version source seen by Electron. On tagged
// release builds, version-from-tag.mjs derives it from the Git tag first. The lock
// file must then mirror it so npm/electron-builder package exactly that version.
if (String(lock.version || '') !== version) {
  throw new Error(`package-lock.json version ${JSON.stringify(lock.version)} does not match package.json ${JSON.stringify(version)}`);
}
if (String(lock.packages?.['']?.version || '') !== version) {
  throw new Error(`package-lock root version ${JSON.stringify(lock.packages?.['']?.version)} does not match package.json ${JSON.stringify(version)}`);
}

function releaseTagForVersion(value) {
  // Keep Vulcan's established release naming: npm/Electron SemVer
  // 1.0.0-rc.16 is published as Git tag v1.0.0rc16.
  const rc = value.match(/^(\d+\.\d+\.\d+)-rc\.(\d+)$/);
  if (rc) return `v${rc[1]}rc${rc[2]}`;
  return `v${value}`;
}

const ref = String(process.env.GITHUB_REF || '');
const refType = String(process.env.GITHUB_REF_TYPE || '');
const actualTag = refType === 'tag'
  ? String(process.env.GITHUB_REF_NAME || ref.replace(/^refs\/tags\//, ''))
  : (ref.startsWith('refs/tags/') ? ref.slice('refs/tags/'.length) : '');

if (actualTag) {
  const expectedTag = releaseTagForVersion(version);
  if (actualTag !== expectedTag) {
    throw new Error(`release tag ${actualTag} does not match package.json version ${version}; expected ${expectedTag}`);
  }
}

console.log(`Vulcan version OK: ${version}${actualTag ? ` (${actualTag})` : ''}`);
