import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');

const tag = String(process.argv[2] || process.env.GITHUB_REF_NAME || '').trim();
if (!tag.startsWith('v')) {
  throw new Error(`release tag must start with v; got ${JSON.stringify(tag)}`);
}

function packageVersionFromTag(value) {
  // Vulcan's release tags use compact RC names such as v1.0.0rc16 while
  // Electron/npm package metadata uses SemVer prerelease notation.
  const rc = value.match(/^v(\d+\.\d+\.\d+)rc(\d+)$/i);
  if (rc) return `${rc[1]}-rc.${rc[2]}`;

  const stable = value.match(/^v(\d+\.\d+\.\d+)$/);
  if (stable) return stable[1];

  throw new Error(
    `unsupported Vulcan release tag ${JSON.stringify(value)}; expected vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCHrcN`,
  );
}

const version = packageVersionFromTag(tag);

const packagePath = path.join(appDir, 'package.json');
const lockPath = path.join(appDir, 'package-lock.json');
const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));

pkg.version = version;
lock.version = version;
if (!lock.packages || !lock.packages['']) {
  throw new Error('package-lock.json is missing the root package entry');
}
lock.packages[''].version = version;

fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

console.log(`Vulcan release version: ${tag} -> ${version}`);
