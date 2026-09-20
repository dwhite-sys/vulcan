import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fileEditor = fs.readFileSync(path.join(appRoot, 'src/app/components/FileEditor.tsx'), 'utf8');
const imageViewer = fs.readFileSync(path.join(appRoot, 'src/app/components/ImageViewer.tsx'), 'utf8');
const workspacePanel = fs.readFileSync(path.join(appRoot, 'src/app/components/WorkspacePanel.tsx'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
const packageLock = JSON.parse(fs.readFileSync(path.join(appRoot, 'package-lock.json'), 'utf8'));

assert.equal(packageJson.dependencies['react-zoom-pan-pinch'], '4.0.3');
assert.equal(packageLock.packages['node_modules/react-zoom-pan-pinch'].version, '4.0.3');

assert.match(fileEditor, /import \{ ImageViewer \} from '\.\/ImageViewer';/);
assert.match(fileEditor, /const isImage = \['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'svg'\]\.includes\(extension\);/);
assert.match(fileEditor, /mode === 'edit' && isImage \? \(/);
assert.match(fileEditor, /<ImageViewer chatId=\{chatId\} path=\{path\} \/>/);
assert.match(fileEditor, /mode === 'edit' && !isImage && \(/);
assert.match(fileEditor, /if \(isImage\) \{[\s\S]*setLoading\(false\);[\s\S]*return;/);

assert.match(imageViewer, /TransformWrapper/);
assert.match(imageViewer, /TransformComponent/);
assert.match(imageViewer, /readFileBase64\(chatId, path\)/);
assert.match(imageViewer, /Scroll to zoom · drag to pan/);
assert.match(imageViewer, /Zoom out/);
assert.match(imageViewer, /Zoom in/);
assert.match(imageViewer, /Fit and center/);
assert.match(imageViewer, /Reset view/);
assert.match(imageViewer, /data-vulcan-image-viewer=\{path\}/);

// Image artifacts must open in the same workspace route rather than becoming download-only.
assert.match(workspacePanel, /function canOpenInWorkspace/);
assert.match(workspacePanel, /return !\['pdf', 'zip', 'tar', 'gz'\]\.includes\(ext\);/);
assert.match(workspacePanel, /canOpenInWorkspace\(file\.name\) \? onOpenFile/);

// The image viewer lives beneath the existing workspace shell. The workspace-level back affordance must survive.
assert.match(workspacePanel, /← Workspace/);
assert.match(workspacePanel, /<FileEditor chatId=\{chatId\} path=\{activeView\.path\} \/>/);

console.log('workspace image viewer regression passed');
