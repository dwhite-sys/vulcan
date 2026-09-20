import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';

const entries = new Map<string, string>();
const context = createContext({
  console,
  localStorage: {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); },
  },
});

const builtinsUrl = new URL('../src/app/skills/builtins.ts', import.meta.url);
const builtinsModule = new SourceTextModule(stripTypeScriptTypes(readFileSync(builtinsUrl, 'utf8')), {
  context,
  initializeImportMeta(meta) {
    meta.glob = () => ({});
  },
});
await builtinsModule.link((specifier) => {
  assert.match(specifier, /\/SKILL\.md\?raw$/);
  const markdown = readFileSync(new URL(specifier.replace(/\?raw$/, ''), builtinsUrl), 'utf8');
  return new SyntheticModule(['default'], function () {
    this.setExport('default', markdown);
  }, { context });
});
await builtinsModule.evaluate();
const { BUILTIN_SKILLS, getActiveBuiltinSkills } = builtinsModule.namespace as any;
const baseline = { cliWorkspaceEnabled: true, panelsEnabled: true };
assert.deepEqual(Array.from(BUILTIN_SKILLS, (skill: any) => skill.name), [
  'tool-discovery', 'etna-usage', 'kit-building', 'terminal', 'visualization', 'preview', 'dashboard-authoring',
]);
assert.equal(getActiveBuiltinSkills(baseline).length, 7, 'All seven Vulcan skills must default to enabled');
assert.deepEqual(
  Array.from(getActiveBuiltinSkills({ ...baseline, disabledVulcanSkills: ['terminal', 'preview'] }),
    (skill: any) => skill.name),
  ['tool-discovery', 'etna-usage', 'kit-building', 'visualization', 'dashboard-authoring'],
);
assert.equal(getActiveBuiltinSkills({ ...baseline, cliWorkspaceEnabled: false })
  .some((skill: any) => skill.name === 'terminal'), false);
assert.match(BUILTIN_SKILLS.find((skill: any) => skill.name === 'tool-discovery')?.body ?? '',
  /Inspection is the boundary between knowing that a capability exists and being able to execute it correctly/,
  'The discovery skill must teach the shared inspection boundary without coupling itself to one execution variant');

const persistenceSource = readFileSync(new URL('../src/app/services/persistence.ts', import.meta.url), 'utf8');
const persistenceModule = new SourceTextModule(stripTypeScriptTypes(persistenceSource), { context });
await persistenceModule.link((specifier) => {
  if (specifier === './transcript') {
    return new SyntheticModule(['rehydrateChatEvents'], function () {
      this.setExport('rehydrateChatEvents', (events: any) => events);
    }, { context });
  }
  if (specifier === './networkProfileScope') {
    return new SyntheticModule(['migrateScopedNetworkValue', 'scopedNetworkKey'], function () {
      this.setExport('migrateScopedNetworkValue', (key: string) => entries.get(key) ?? null);
      this.setExport('scopedNetworkKey', (key: string) => key);
    }, { context });
  }
  if (specifier === './vulcan') {
    const names = ['remoteLoadChats', 'remoteSaveChat', 'remoteDeleteChat', 'remoteLoadChatFolders', 'remoteSaveChatFolders'];
    return new SyntheticModule(names, function () {
      for (const name of names) this.setExport(name, async () => undefined);
    }, { context });
  }
  throw new Error(`Unexpected persistence dependency: ${specifier}`);
});
await persistenceModule.evaluate();
const { loadVulcanSettings, saveVulcanSettings } = persistenceModule.namespace as any;
assert.deepEqual(Array.from(loadVulcanSettings().disabledVulcanSkills), []);
assert.equal(loadVulcanSettings().discoveryExecution, 'search-inspect');
saveVulcanSettings({ ...loadVulcanSettings(), disabledVulcanSkills: ['preview', 'terminal'] });
assert.deepEqual(Array.from(loadVulcanSettings().disabledVulcanSkills), ['preview', 'terminal']);
entries.set('vulcan:settings', JSON.stringify({ disabledVulcanSkills: 'preview' }));
assert.deepEqual(Array.from(loadVulcanSettings().disabledVulcanSkills), [],
  'Malformed old preferences must not silently disable built-in skills');

const etna = {
  listSkills: async () => [
    { name: 'etna-enabled', description: 'Enabled Etna procedure', source: 'skills' },
    { name: 'etna-disabled', description: 'Disabled Etna procedure', source: 'skills' },
  ],
  searchSkills: async () => [
    { name: 'etna-enabled', description: 'Enabled Etna procedure', source: 'skills' },
    { name: 'etna-disabled', description: 'Disabled Etna procedure', source: 'skills' },
  ],
  inspectKit: async () => ({}),
  readSkill: async (name: string) => ({ name, body: `body:${name}` }),
  listSkillFiles: async (name: string) => {
    if (name === 'etna-legacy') throw new Error('Not Found');
    return { skill: name, files: ['SKILL.md', 'references/etna.md'] };
  },
  readSkillFile: async (name: string, file: string) => {
    if (name === 'etna-legacy') throw new Error('Not Found');
    return { skill: name, file, content: `body:${file}` };
  },
};
const serviceSource = readFileSync(new URL('../src/app/services/skillService.ts', import.meta.url), 'utf8');
const serviceModule = new SourceTextModule(stripTypeScriptTypes(serviceSource), { context });
await serviceModule.link((specifier) => {
  if (specifier === '../skills/builtins') return builtinsModule;
  if (specifier === './vulcanClient') {
    return new SyntheticModule(['vulcanClient'], function () {
      this.setExport('vulcanClient', etna);
    }, { context });
  }
  throw new Error(`Unexpected skill-service dependency: ${specifier}`);
});
await serviceModule.evaluate();
const {
  listAvailableSkills,
  searchAvailableSkills,
  readAvailableSkill,
  listAvailableSkillFiles,
  readAvailableSkillFile,
} = serviceModule.namespace as any;
const availability = {
  settings: { ...baseline, disabledVulcanSkills: ['preview', 'tool-discovery'] },
  enabledGeneralSkills: [{ name: 'etna-enabled', source: 'skills' }],
  enabledKits: [],
};
const available = await listAvailableSkills(availability);
assert.equal(available.some((skill: any) => skill.name === 'preview'), false);
assert.equal(available.some((skill: any) => skill.name === 'tool-discovery'), false);
assert.equal(available.some((skill: any) => skill.name === 'etna-disabled'), false);
assert.equal(available.some((skill: any) => skill.name === 'etna-enabled'), true);
const searched = await searchAvailableSkills('preview', availability);
assert.equal(searched.some((skill: any) => skill.name === 'preview'), false);
await assert.rejects(readAvailableSkill('preview', 'vulcan', availability), /not available/);
await assert.rejects(listAvailableSkillFiles('preview', 'vulcan', availability), /not available/);
await assert.rejects(readAvailableSkillFile('preview', 'SKILL.md', 'vulcan', availability), /not available/);
assert.equal((await readAvailableSkill('visualization', 'vulcan', availability)).name, 'visualization');

const packageSource = readFileSync(new URL('../src/app/services/skillPackageFiles.ts', import.meta.url), 'utf8');
const packageModule = new SourceTextModule(stripTypeScriptTypes(packageSource), { context });
const builtinFiles = ['SKILL.md', 'references/deep.md', 'assets/logo.png', 'scripts/build.ts'];
await packageModule.link((specifier) => {
  if (specifier === '../skills/builtins') {
    return new SyntheticModule(['listBuiltinSkillFiles', 'readBuiltinSkillFile'], function () {
      this.setExport('listBuiltinSkillFiles', () => builtinFiles);
      this.setExport('readBuiltinSkillFile', async (name: string, file: string) => file.endsWith('.png')
        ? { skill: name, file, binary: true, contentType: 'image/png', base64: 'aW1hZ2U=' }
        : { skill: name, file, content: `builtin:${file}` });
    }, { context });
  }
  if (specifier === './vulcanClient') {
    return new SyntheticModule(['vulcanClient'], function () {
      this.setExport('vulcanClient', etna);
    }, { context });
  }
  throw new Error(`Unexpected skill-package dependency: ${specifier}`);
});
await packageModule.evaluate();
const {
  buildSkillFileTree,
  formatSkillDisplayName,
  listSkillPackageFiles,
  readSkillPackageFile,
  stripSkillFrontmatter,
} = packageModule.namespace as any;
const tree = JSON.parse(JSON.stringify(buildSkillFileTree([
  'references/deep.md', 'SKILL.md', 'assets/logo.png', 'scripts/build.ts',
  'references/nested/detail.md', 'SKILL.md', '../outside.md', '/absolute.md',
  'references/../../escape.md', 'invalid//file.md', './notes.md',
])));
assert.deepEqual(tree.map((node: any) => node.path),
  ['SKILL.md', 'assets', 'references', 'scripts', 'notes.md'],
  'The primary skill file should lead a hierarchy of sorted folders and files');
assert.deepEqual(tree.find((node: any) => node.path === 'references').children.map((node: any) => node.path),
  ['references/nested', 'references/deep.md']);
assert.deepEqual(tree.find((node: any) => node.path === 'references').children[0].children.map((node: any) => node.path),
  ['references/nested/detail.md']);
assert.equal(formatSkillDisplayName('tool-discovery'), 'Tool Discovery');
assert.equal(formatSkillDisplayName('etna_usage'), 'Etna Usage');
assert.equal(formatSkillDisplayName('API helper'), 'API Helper');
assert.equal(stripSkillFrontmatter('---\nname: demo\ndescription: Hidden metadata\n---\n# Visible\nBody'), '# Visible\nBody');
assert.equal(stripSkillFrontmatter('# Already visible\nBody'), '# Already visible\nBody');
assert.deepEqual(Array.from(await listSkillPackageFiles({ name: 'preview', source: 'vulcan' })), builtinFiles,
  'Settings must retain administrative visibility into disabled built-in skill packages');
assert.equal((await readSkillPackageFile({ name: 'preview', source: 'vulcan' }, 'SKILL.md')).content,
  'builtin:SKILL.md');
assert.equal((await readSkillPackageFile({ name: 'preview', source: 'vulcan' }, 'assets/logo.png')).binary,
  true, 'Image assets should remain available to the skill-file previewer');
assert.deepEqual(Array.from(await listSkillPackageFiles({ name: 'etna-disabled', source: 'skills' })),
  ['SKILL.md', 'references/etna.md']);
assert.equal((await readSkillPackageFile({ name: 'etna-disabled', source: 'skills' }, 'references/etna.md')).content,
  'body:references/etna.md');
assert.deepEqual(Array.from(await listSkillPackageFiles({ name: 'etna-legacy', source: 'skills' })), ['SKILL.md'],
  'Legacy Etna skills should report their whole-skill document as one file child');
assert.equal((await readSkillPackageFile({ name: 'etna-legacy', source: 'skills' }, 'SKILL.md')).content,
  'body:etna-legacy', 'Legacy Etna SKILL.md should remain openable through the whole-skill reader');

const settings = readFileSync(new URL('../src/app/components/SettingsDialog.tsx', import.meta.url), 'utf8');
const explorer = readFileSync(new URL('../src/app/components/SkillPackageExplorer.tsx', import.meta.url), 'utf8');
const kitExplorer = readFileSync(new URL('../src/app/components/KitContentsExplorer.tsx', import.meta.url), 'utf8');
const skillsSection = settings.split('{/* Skills */}')[1]?.split('{/* Vulcan Settings */}')[0] ?? '';
const kitsSection = settings.split('{/* Kits */}')[1]?.split('{/* Skills */}')[0] ?? '';
const menu = readFileSync(new URL('../src/app/components/SkillToggleMenu.tsx', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/app/App.tsx', import.meta.url), 'utf8');
const vulcanTools = readFileSync(new URL('../src/app/services/vulcanTools.ts', import.meta.url), 'utf8');
const etnaRegistry = readFileSync(new URL('../src/app/services/etnaRegistry.ts', import.meta.url), 'utf8');
assert.match(app, /Enabled Etna capability index \(names only; schemas are not loaded\)/,
  'Both discovery variants must expose the same names-only Etna capability index');
assert.match(app, /Inspect an indexed tool before executing it through run_tool/,
  'The wrapper variant must direct inspected tools through run_tool');
assert.match(app, /Inspecting an indexed tool loads it for direct use on the next turn/,
  'The promotion variant must describe the deterministic schema transition');
assert.match(app, /Etna tools are not listed in advance in this mode\. Discover them on demand through capability search/,
  'The search-led variant must omit the Etna inventory and frame capability search as the entry point');
assert.match(vulcanTools, /name: 'run_tool'[\s\S]*?required: \['name', 'arguments'\]/,
  'The wrapper variant must retain run_tool with name and arguments');
assert.match(vulcanTools, /discoveryExecution === 'wrapper' \|\| tool\.name !== 'run_tool'/,
  'The promotion variant must remove run_tool from the provider-visible schema');
assert.match(vulcanTools, /if \(toolName === 'run_tool'\)[\s\S]*?vulcanClient\.runTool\(discoveredName, discoveredArguments\)/,
  'The client-side compatibility runner must dispatch run_tool through Etna');
assert.match(vulcanTools, /use inspect_tool on the best returned match to see its exact schema and make it callable/,
  'search_tools must explicitly hand off from discovery to callability');
assert.match(vulcanTools, /guidance: `\$\{tool\.name\} is now directly callable\.`/,
  'inspect_tool results must explicitly confirm that the promoted tool is callable');
assert.match(vulcanTools, /Images are for vision models only:[\s\S]*?whole-image overview fitted within 512x512/,
  'view_file must clearly disclose the image modality and bounded overview behavior');
assert.match(vulcanTools, /region:[\s\S]*?x:[\s\S]*?y:[\s\S]*?additionalProperties: false/,
  'view_file must expose a fixed detail-window origin in original-image coordinates');
assert.match(vulcanTools, /Math\.min\(1, 512 \/ originalWidth, 512 \/ originalHeight\)/,
  'The compatibility runner must preserve aspect ratio within a 512x512 overview');
assert.doesNotMatch(vulcanTools, /likelyHasVision|modelLower\.includes\('vision'\)/,
  'Image execution must not reject capable models through model-name substring guessing');
assert.match(app, /Whole-image overview of \$\{parsed\.filename\}/,
  'The image context notice must identify overview geometry to the model');
assert.match(settings, /Discovery Execution[\s\S]*?RUN TOOL[\s\S]*?PROMOTE[\s\S]*?SEARCH/,
  'Search settings must expose all three comparison variants');
assert.match(settings, />Skills<\/p>/);
assert.doesNotMatch(settings, /General Skills|No general skills installed/);
assert.match(settings, /label: 'Vulcan', items: skills\.filter/);
assert.match(settings, /label: 'Etna', items: skills\.filter/);
assert.match(settings, /activeSkillCategory, setActiveSkillCategory\] = useState<'vulcan' \| 'etna'>\('vulcan'\)/,
  'The pill selector must default to Vulcan');
assert.match(settings, /role="tablist"[\s\S]*?rounded-full/,
  'Vulcan and Etna must be presented as an accessible segmented pill selector');
assert.match(settings, /skillCategories\.filter\(\(category\) => category\.id === activeSkillCategory\)/,
  'Only the selected skill category should be visible');
assert.match(skillsSection, /<div className="space-y-2">/,
  'Skill cards should use the same separated vertical rhythm as kit cards');
assert.match(skillsSection, /overflow-hidden rounded-lg border border-ash-700 bg-ash-850/,
  'Each skill should use the same individual rounded-card treatment as a kit');
assert.match(skillsSection, /flex items-start gap-2 px-3 py-3 transition-colors hover:bg-ash-800/,
  'Skill rows should remain visually consistent with Vulcan while accommodating multiline descriptions');
assert.doesNotMatch(skillsSection, /provider-online-dot|bg-green-400/,
  'Skill rows must not display misleading provider-style live-status dots');
assert.match(skillsSection, /expanded \? 'whitespace-normal' : 'truncate'/,
  'Collapsed descriptions should ellipsize at one line and expanded descriptions should display in full');
assert.match(settings, /listSkillPackageFiles\(skill\)\)\.length/,
  'Skill cards should derive their displayed child count from the real package contents');
assert.match(settings, /skillFileCountKey[\s\S]*?\[isOpen, skillFileCountKey\]/,
  'File-count loading should not loop when App recreates its projected skill array');
assert.match(settings, /const skillFileCountKey = JSON\.stringify\(/,
  'The stable file-count key should use an ECMAScript-module-safe serialization');
assert.doesNotMatch(settings, /\\[1-7]/,
  'Settings source must not contain legacy octal escape sequences rejected by Vite/esbuild');
assert.match(skillsSection, /fileCount === 1 \? 'file' : 'files'/,
  'Skill cards should display a grammatically correct file-child count beside the name');
assert.match(skillsSection, /const displayName = formatSkillDisplayName\(skill\.name\)/,
  'Machine-oriented skill names should be converted to human-readable card titles');
assert.match(skillsSection, /onClick=\{\(\) => toggleSkillPackage\(skill\.stem\)\}/,
  'Clicking the skill summary should expand its package browser');
assert.match(skillsSection, /aria-expanded=\{expanded\}/,
  'Expandable skill rows should expose their state accessibly');
assert.match(skillsSection, /<SkillPackageExplorer skill=\{skill\} \/>/,
  'Expanded skill rows should render the reusable package-file browser');
assert.match(explorer, /listSkillPackageFiles\(descriptor\)/);
assert.match(explorer, /readSkillPackageFile\(descriptor, path\)/);
assert.match(explorer, /<MarkdownRenderer content=\{stripSkillFrontmatter\(selectedFile\.content\)\} \/>/,
  'Markdown skill files should hide YAML name and description metadata before rendering');
assert.match(explorer, /selectedFile\.contentType\.startsWith\('image\/'\)/,
  'Binary skill images should receive an inline image preview');
assert.match(explorer, /whitespace-pre-wrap break-words font-mono/,
  'Text and source files should display in a readable code-style viewer');
assert.match(kitsSection, /<KitContentsExplorer/,
  'Expanded kits should use the package-style contents browser');
assert.match(kitsSection, /line-clamp-4 whitespace-normal/,
  'Kit descriptions should use the same four-line treatment as skills');
assert.doesNotMatch(kitsSection, /<Package|<Wrench|<BookOpen/,
  'The old stacked kit, tool-card, and separate skill-detail visuals should be removed');
assert.doesNotMatch(kitsSection, />ENABLED<|>DISABLED<|kit\.filename<\/span>/,
  'Kit rows should retain the compact skill-row visual hierarchy');
assert.ok(kitExplorer.indexOf('<span className="truncate">skill</span>')
  < kitExplorer.indexOf('<span className="truncate">{kit.filename}</span>'),
  'The real skill directory must appear before its sibling Python kit file');
assert.match(kitExplorer, /skillTree\.map\(\(node\) => renderSkillNode\(node\)\)/,
  'The skill directory should expand into its real package hierarchy');
assert.match(kitExplorer, /toolFileOpen && kit\.tools\.map/,
  'Discovered tools should nest beneath the Python kit file');
assert.match(kitExplorer, /onClick=\{\(\) => onToggleTool\(toolKey\)\}/,
  'Every nested tool should retain its independent visibility toggle');
assert.match(kitExplorer, /listEtnaSkillFiles\(etnaSource, resolvedSkillName, kit\.skill \?\? undefined\)/);
assert.match(kitExplorer, /readEtnaSkillFile\(etnaSource, resolvedSkillName, path, kit\.skill \?\? undefined\)/,
  'Paired-skill files should open through Etna’s real package-file API');
assert.match(kitExplorer, /readEtnaSkill\(etnaSource, resolvedSkillName, kit\.skill \?\? undefined\)/,
  'Older Etna servers without package-file routes should fall back to the whole-skill reader');
assert.match(kitExplorer, /legacySkillBody\.current = legacy\.body/,
  'The legacy skill fallback should remain openable as a virtual SKILL.md file');
assert.match(kitExplorer, /<MarkdownRenderer content=\{stripSkillFrontmatter\(fileContent\.content\)\} \/>/,
  'Kit-paired skills should hide YAML metadata through the same Markdown display path');
assert.match(kitExplorer, />Prompt<\/div>[\s\S]*?>Parameters<\/div>/,
  'Tool prompts and parameters should use matching labeled section headers');
assert.match(kitExplorer, /whitespace-pre-wrap border-t border-ash-700\/50 py-2 text-sm leading-5 text-ash-300/,
  'Selecting a tool should display its complete model-facing prompt');
assert.doesNotMatch(kitExplorer, /Skill files|>Tools</,
  'The contents tree should not add redundant Tools or Skill headers');
assert.match(kitExplorer, /overflow-x-hidden overflow-y-auto/,
  'Long tool names must not create a horizontal scrollbar in the contents tree');
assert.match(kitExplorer, /flex w-full min-w-0 items-center gap-1 overflow-hidden/,
  'Tool rows should reserve stable space for their independent switches');
assert.match(kitExplorer, /h-4 w-8 shrink-0 rounded-full/,
  'Per-tool switches should use the same dimensions as the kit switch');
assert.match(kitExplorer, /absolute left-0\.5 top-0\.5 h-3 w-3/,
  'Per-tool switch knobs must be anchored inside their tracks');
assert.match(kitsSection, /absolute left-0\.5 top-0\.5 w-3 h-3/,
  'Kit switch knobs must be anchored inside their tracks');
assert.doesNotMatch(settings, /grid grid-cols-1 gap-4 sm:grid-cols-2/,
  'The old simultaneous side-by-side category layout should be removed');
assert.match(menu, /label: 'Vulcan', items: skills\.filter/);
assert.match(menu, /label: 'Etna', items: skills\.filter/);
assert.match(app, /skills=\{allSkills\}/);
assert.match(app, /handleVulcanSettingsChange\(\{ disabledVulcanSkills:/);
assert.match(app, /settings: vulcanSettings/,
  'Server-owned inference must receive disabled Vulcan skill preferences');

console.log('Skill visibility enforcement, expandable package files, and hierarchical kit skill/file/tool inspection verified.');

assert.match(etnaRegistry, /Older Etna versions omitted source/);
assert.match(etnaRegistry, /source: typeof skill\?\.source === 'string'.*'skills'/);
assert.match(etnaRegistry, /skill_source/);
assert.match(etnaRegistry, /effective_source/);
