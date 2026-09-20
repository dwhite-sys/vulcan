import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const tools = read('src/app/services/vulcanTools.ts');
const app = read('src/app/App.tsx');
const surface = read('src/app/components/DesignSurface.tsx');
const preload = read('electron/designPreload.cjs');
const desktopPreload = read('electron/preload.cjs');
const main = read('electron/main.cjs');

for (const name of [
  'design_inspect', 'design_click', 'design_fill', 'design_press', 'design_hover',
  'design_scroll', 'design_select_option', 'design_get_text', 'design_get_attribute', 'design_screenshot',
]) {
  assert.match(tools, new RegExp(`name: '${name}'`), `${name} must exist in the live-surface cluster`);
}
assert.match(tools, /getDesignSurfaceTools\(modelVision/);
assert.match(tools, /tool\.name !== 'design_screenshot' \|\| modelVision === true/);
assert.match(tools, /ctx\.designSurfaceOpen\(\)/);
assert.match(tools, /ctx\.designSurfaceAvailable\(\)/);
assert.match(tools, /browser controller interaction DOM page/);
assert.match(tools, /matches\.push\(\{ kit: 'Design'/);
assert.match(tools, /design_screenshot_unavailable/);
assert.match(tools, /ctx\.designCaptureScreenshot\(\)/);
assert.match(tools, /actual current Design/);
assert.match(tools, /actual pixels of the currently visible Design frame/);
assert.match(tools, /prefer visual evidence over inferring appearance from source or DOM alone/);
assert.match(tools, /DESIGN_SURFACE_SEARCH_CONTEXT = 'Design live surface frontend rendered application UI precision'/);
assert.match(tools, /Opening it has made its live-surface control tools discoverable through search_tools/);

assert.match(app, /DesignSurfaceHandle/);
assert.match(app, /designSurfaceOpen: \(\) => Boolean\(openDesignId\)/);
assert.match(app, /designSurfaceAvailable: \(\) => Boolean\(designSurfaceRef\.current\?\.isReady\(\)\)/);
assert.match(app, /getDesignSurfaceTools\(isVisionModel\(selectedModel\)\)/);
assert.match(app, /designCaptureScreenshot/);
assert.match(app, /ref=\{designSurfaceRef\}/);

assert.match(app, /waitForDesignSurfaceReady/);
assert.match(app, /getIdentity\(\)/);
assert.match(app, /existingIndex = current\.findIndex/);
assert.match(app, /targetUrl: design\.url/);
assert.match(app, /design_surface_open_timeout/);
assert.match(app, /design_surface_not_ready/);
assert.match(main, /design_screenshot_capture_timeout/);
assert.match(main, /design_screenshot_upload_timeout/);
assert.match(main, /Page\.captureScreenshot/);
assert.match(main, /captureNativePng/);
assert.match(main, /captureCdpPng/);
assert.match(main, /uploadOnce/);
assert.match(main, /nativeImage\.createFromBuffer\(png\)\.getSize\(\)/);
assert.doesNotMatch(main, /const size = image\.getSize\(\)/, 'Screenshot metadata must not reference captureNativePng local state after upload');

assert.match(surface, /getWebContentsId\?: \(\) => number/);
assert.match(surface, /getIdentity: \(\) => \(\{ designId: design\.id, targetUrl: design\.url \}\)/);
assert.match(surface, /screenshots\/design-/);
assert.match(surface, /electronAPI\?\.designScreenshot\?\.capture/);
assert.doesNotMatch(surface, /uploadWorkspaceFile/, 'Design screenshot bytes must not use the renderer workspace upload path');
assert.doesNotMatch(surface, /capturePage\(/, 'Design screenshot pixels must not be captured in the host React renderer');
assert.match(desktopPreload, /vulcan-design-screenshot-capture/);
assert.match(main, /guest\.capturePage\(\)/);
assert.match(main, /design-screenshot\/\$\{encodeURIComponent\(chatId\)\}/);
assert.match(main, /body: png/);
assert.match(surface, /vulcan-design-tool-request/);
assert.match(surface, /vulcan-design-tool-response/);

assert.match(surface, /const sendToGuest = useCallback/);
assert.match(surface, /!webview\.isConnected/);
assert.match(surface, /if \(!sendToGuest\('vulcan-design-tool-request'/);
assert.match(surface, /addEventListener\('did-fail-load'/);
assert.match(surface, /Design unavailable/);
assert.doesNotMatch(surface, /webview\?\.send\?\.\('vulcan-design-select-mode'/, 'Selection mode must not send before dom-ready');
assert.doesNotMatch(surface, /webviewRef\.current\?\.send\?\.\('vulcan-design-select-mode'/, 'Escape handling must use the guarded guest sender');
assert.match(surface, /const selectingRef = useRef\(false\)/);
assert.match(surface, /sendToGuest\('vulcan-design-select-mode', selectingRef\.current\)/);
assert.doesNotMatch(surface, /\[onElement, design\.id, design\.url, chatId, selecting, sendToGuest\]/, 'Selection state must not tear down the webview lifecycle effect');

assert.match(preload, /function inspectSurface\(\)/);
assert.match(preload, /const handle = `e\$\{interactive\.length \+ 1\}`/);
assert.match(preload, /visible_text: visibleText/);
assert.match(preload, /function resolveTarget\(target\)/);
assert.match(preload, /design_select_option/);
assert.match(preload, /vulcan-design-tool-request/);
assert.match(preload, /vulcan-design-tool-response/);

console.log('Design live-surface regression: ok');

assert.match(surface, /sendInputEvent/);
assert.match(surface, /__design_target_point/);
assert.match(surface, /__design_focus/);
