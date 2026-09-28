import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, '..');
const workspace = fs.readFileSync(path.join(app, 'src/app/components/WorkspacePanel.tsx'), 'utf8');
const widget = fs.readFileSync(path.join(app, 'src/app/components/TerminalSlotWidget.tsx'), 'utf8');

function requireText(source, text, why) {
  if (!source.includes(text)) throw new Error(`terminal slot persistence regression: ${why}`);
}
function forbidText(source, text, why) {
  if (source.includes(text)) throw new Error(`terminal slot persistence regression: ${why}`);
}

requireText(workspace, ".filter((s) => s.status !== 'closed-inactivity')", 'open slots are not kept mounted');
requireText(workspace, '.map((s) => {', 'terminal viewers are not rendered per slot');
requireText(workspace, 'active={active}', 'selection is not modeled as viewer visibility');
forbidText(workspace, 'key={`${chatId}-${activeTerminalSlot.kind}-${activeTerminalSlot.slot}', 'active slot is still the sole keyed/remounted viewer');
requireText(widget, "visibility: active ? 'visible' : 'hidden'", 'inactive xterms are not preserved in-layout');
requireText(widget, "pointerEvents: active ? 'auto' : 'none'", 'inactive xterms can capture input');
requireText(widget, 'if (!active) return;', 'activation does not refresh fit/focus');
requireText(widget, 'xtermRef.current?.focus()', 'selected terminal is not focused');

console.log('terminal slot persistence regression: PASS');
