import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const settingsPath = path.join(root, 'src/app/components/SettingsDialog.tsx');
const source = fs.readFileSync(settingsPath, 'utf8');

for (const removed of ['setVulcanTestStatus', 'setEtnaServerStatus']) {
  if (source.includes(removed)) {
    throw new Error(`Renderer startup regression: stale removed state setter ${removed} remains in SettingsDialog`);
  }
}

// SettingsDialog is always mounted by TopBar even when closed, so its effects run
// during application startup. Keep this assertion tied to the actual render path.
const topBar = fs.readFileSync(path.join(root, 'src/app/components/TopBar.tsx'), 'utf8');
if (!topBar.includes('<SettingsDialog')) {
  throw new Error('Startup smoke invariant changed: SettingsDialog is no longer mounted by TopBar');
}


// Historical GSOD guards: these failures have previously left Electron showing
// only the renderer background because React never completed startup.
const chatInterface = fs.readFileSync(path.join(root, 'src/app/components/ChatInterface.tsx'), 'utf8');
if (/\bsetActiveComposerTarget\s*\(/.test(chatInterface) && !/const\s+setActiveComposerTarget\s*=/.test(chatInterface)) {
  throw new Error('Renderer startup regression: setActiveComposerTarget is called but not defined');
}

const wsSource = fs.readFileSync(path.join(root, 'src/app/services/ws.ts'), 'utf8');
if (/from\s+['"]\.\/ws['"]/.test(wsSource)) {
  throw new Error('Renderer startup regression: ws.ts imports itself');
}

const mainSource = fs.readFileSync(path.join(root, 'src/main.tsx'), 'utf8');
if (!mainSource.includes('RendererErrorBoundary') || !mainSource.includes('Vulcan renderer error')) {
  throw new Error('Renderer startup regression: top-level renderer error boundary is missing');
}

console.log('renderer startup regression: ok');
