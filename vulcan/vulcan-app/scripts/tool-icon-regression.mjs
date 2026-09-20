import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const component = await readFile(new URL('../src/app/components/ChatMessage.tsx', import.meta.url), 'utf8');
const schemas = JSON.parse(await readFile(new URL('../../vulcan/vulcan/agent_assets/tool_schemas.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const lockfile = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
const expectedLucideVersion = manifest.dependencies['lucide-react'];
assert.equal(lockfile.packages[''].dependencies['lucide-react'], expectedLucideVersion,
  'The package lock must request the same Lucide version as package.json');
assert.equal(lockfile.packages['node_modules/lucide-react'].version, expectedLucideVersion,
  'The package lock must resolve the requested Lucide version');
const block = component.match(/const NATIVE_TOOL_ICONS[^=]*=\s*\{([\s\S]*?)\n\};/);
assert.ok(block, 'Native tool icon registry was not found');

const mapped = new Map(
  [...block[1].matchAll(/^\s*([a-z][a-z0-9_]*):\s*\{\s*icon:\s*([A-Za-z][A-Za-z0-9]*)/gm)]
    .map((match) => [match[1], match[2]]),
);
const tools = Object.values(schemas).flat().map((tool) => tool.name);
const missing = tools.filter((name) => !mapped.has(name));
const stale = [...mapped.keys()].filter((name) => !tools.includes(name));

assert.deepEqual(missing, [], `Native tools missing icons: ${missing.join(', ')}`);
assert.deepEqual(stale, [], `Icon registry references nonexistent tools: ${stale.join(', ')}`);
const approved = {
  recall: 'BrainCircuit',
  ask_user: 'CircleHelp',
  list_skills: 'BookCopy',
  search_skills: 'BookSearch',
  read_skill: 'BookOpen',
  list_skill_files: 'NotebookText',
  read_skill_file: 'NotepadTextDashed',
  open_terminal: 'SquareTerminal',
  close_terminal: 'OctagonX',
  switch_terminal: 'RotateCcw',
  read_output: 'ScanText',
  list_terminals: 'ListCollapse',
  find_in_file: 'TextSearch',
  workspace_history: 'History',
  workspace_diff: 'Diff',
  workspace_restore: 'RotateCcwClock',
  dashboard_create: 'MonitorUp',
  dashboard_update: 'MonitorCog',
  dashboard_inspect: 'MonitorCheck',
  dashboard_list: 'Monitor',
  dashboard_delete: 'Trash2',
  design_register: 'MonitorUp',
  design_update: 'MonitorCog',
  design_info: 'MonitorCheck',
  design_list: 'Monitor',
  design_remove: 'Trash2',
  open_design: 'LayoutDashboard',
  design_inspect: 'Scan',
  design_click: 'MousePointer2',
  design_fill: 'FilePen',
  design_press: 'CornerDownLeft',
  design_hover: 'MousePointer2',
  design_scroll: 'ChevronDown',
  design_select_option: 'Check',
  design_get_text: 'TextSearch',
  design_get_attribute: 'ScanText',
  design_screenshot: 'Image',
};
for (const [tool, icon] of Object.entries(approved)) {
  assert.equal(mapped.get(tool), icon, `${tool} must use its approved ${icon} icon`);
}
const componentImports = component.match(/import\s*\{([^}]+)\}\s*from\s*['"]lucide-react['"]/);
assert.ok(componentImports, 'ChatMessage must directly import its Lucide icons');
for (const icon of ['BookSearch', 'RotateCcwClock']) {
  assert.match(componentImports[1], new RegExp(`\\b${icon}\\b`),
    `${icon} must come directly from the installed Lucide package`);
}
assert.doesNotMatch(component, /createLucideIcon/, 'Approved icons must not use custom compatibility shims');
assert.match(component, /NATIVE_TOOL_ICONS\[name\]\s*\?\?\s*\{\s*icon:\s*Wrench/, 'External tools must retain their generic fallback');

let installedLucide = null;
try {
  installedLucide = JSON.parse(await readFile(new URL('../node_modules/lucide-react/package.json', import.meta.url), 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

if (installedLucide) {
  assert.equal(installedLucide.version, expectedLucideVersion,
    `Installed lucide-react is ${installedLucide.version}; run npm install to obtain ${expectedLucideVersion}`);
  const lucide = await import('lucide-react');
  const appDirectory = new URL('../src/app/', import.meta.url);
  const appFiles = await readdir(appDirectory, { recursive: true });
  const importedIcons = new Set();

  for (const file of appFiles.filter((name) => /\.[jt]sx?$/.test(name))) {
    const source = await readFile(new URL(file, appDirectory), 'utf8');
    for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]lucide-react['"]/g)) {
      for (const specifier of match[1].split(',')) {
        const trimmed = specifier.trim();
        if (!trimmed || trimmed.startsWith('type ')) continue;
        importedIcons.add(trimmed.split(/\s+as\s+/)[0]);
      }
    }
  }

  const unavailable = [...importedIcons].filter((name) => !(name in lucide)).sort();
  assert.deepEqual(unavailable, [],
    `lucide-react@${expectedLucideVersion} does not export: ${unavailable.join(', ')}`);
  console.log(`Verified ${importedIcons.size} Lucide exports against installed lucide-react@${expectedLucideVersion}.`);
} else {
  console.log(`Lucide export verification will run after lucide-react@${expectedLucideVersion} is installed.`);
}

console.log(`All ${tools.length} native tools have icons; all ${Object.keys(approved).length} approved choices match.`);
