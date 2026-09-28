import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../src/app/App.tsx', import.meta.url), 'utf8');
const adapter = readFileSync(new URL('../src/app/services/etnaOfficialKits.ts', import.meta.url), 'utf8');
const docker = readFileSync(new URL('../../vulcan/vulcan/docker.py', import.meta.url), 'utf8');

assert.match(adapter, /kitName === PLAYWRIGHT_KIT_NAME && toolName === PLAYWRIGHT_SCREENSHOT_TOOL/,
  'Screenshot interception must be scoped to the official Playwright kit and browser_screenshot tool');
assert.match(adapter, /return_base64:\s*true/,
  'Vulcan must force screenshot bytes across the Etna host/container boundary');
assert.match(adapter, /save_path:\s*`\/tmp\/vulcan-playwright-/,
  'The Etna call must use a host-safe temporary path rather than the model workspace path');
assert.match(adapter, /screenshots\/playwright-/,
  'Playwright screenshots must materialize under the visible workspace screenshots directory');
assert.match(adapter, /uploadWorkspaceFile\(chatId, file, workspacePath/,
  'Screenshot bytes must use the normal encrypted workspace upload path');
assert.match(adapter, /png_base64:\s*_discarded/,
  'Raw screenshot base64 must be removed before transcript/model persistence');
assert.match(adapter, /saved_to:\s*`\/workspace\//,
  'The Etna host save path must be rewritten to the model-visible workspace path');
assert.match(app, /prepareOfficialEtnaArguments\(toolKit\.kit_name, toolName, args\)/,
  'Etna arguments must pass through the official-kit adapter before execution');
assert.match(app, /materializeOfficialPlaywrightScreenshot\(currentChat\.id, tc\.id, toolResult, args\.save_path\)/,
  'Successful official Playwright screenshot results must be materialized at the requested current-workspace path');
assert.match(docker, /\bfzf\b/,
  'The standard workspace toolbox must include fzf');

console.log('Official Etna Playwright screenshot materialization and fzf baseline verified.');
