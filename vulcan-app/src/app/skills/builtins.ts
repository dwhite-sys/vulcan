import toolDiscoveryRaw from './builtin/tool-discovery/SKILL.md?raw';
import etnaUsageRaw from './builtin/etna-usage/SKILL.md?raw';
import kitBuildingRaw from './builtin/kit-building/SKILL.md?raw';
import terminalRaw from './builtin/terminal/SKILL.md?raw';
import visualizationRaw from './builtin/visualization/SKILL.md?raw';
import previewRaw from './builtin/preview/SKILL.md?raw';
import dashboardAuthoringRaw from './builtin/dashboard-authoring/SKILL.md?raw';

export interface BuiltinSkillSettings {
  cliWorkspaceEnabled: boolean;
  panelsEnabled: boolean;
  disabledVulcanSkills?: string[];
}

export interface BuiltinSkill {
  name: string;
  description: string;
  body: string;
  source: 'vulcan';
  isActive: (settings: BuiltinSkillSettings) => boolean;
}

function parseSkillMd(raw: string, fallbackName: string): { name: string; description: string; body: string } {
  let name = fallbackName;
  let description = '';
  let body = raw.trim();

  if (raw.startsWith('---')) {
    const end = raw.indexOf('---', 3);
    if (end !== -1) {
      const frontmatter = raw.slice(3, end).trim();
      for (const line of frontmatter.split(/\r?\n/)) {
        if (line.startsWith('name:')) name = line.slice(5).trim();
        else if (line.startsWith('description:')) description = line.slice(12).trim();
      }
      body = raw.slice(end + 3).trim();
    }
  }

  return { name, description, body };
}

function builtin(
  fallbackName: string,
  raw: string,
  isActive: BuiltinSkill['isActive'],
): BuiltinSkill {
  return { ...parseSkillMd(raw, fallbackName), source: 'vulcan', isActive };
}

export const BUILTIN_SKILLS: BuiltinSkill[] = [
  builtin('tool-discovery', toolDiscoveryRaw, () => true),
  builtin('etna-usage', etnaUsageRaw, () => true),
  builtin('kit-building', kitBuildingRaw, () => true),
  builtin('terminal', terminalRaw, ({ cliWorkspaceEnabled }) => cliWorkspaceEnabled),
  builtin('visualization', visualizationRaw, () => true),
  builtin('preview', previewRaw, () => true),
  builtin('dashboard-authoring', dashboardAuthoringRaw, ({ panelsEnabled }) => panelsEnabled),
];

export function getActiveBuiltinSkills(settings: BuiltinSkillSettings): BuiltinSkill[] {
  const disabled = new Set(settings.disabledVulcanSkills ?? []);
  return BUILTIN_SKILLS.filter((skill) => !disabled.has(skill.name) && skill.isActive(settings));
}

// Every bundled Vulcan skill is a real directory-backed skill package. Vite
// turns each resource into a packaged URL so SKILL.md, references, scripts,
// assets, and future nested resources all share the same internal protocol.
const BUILTIN_SKILL_FILE_URLS = import.meta.glob('./builtin/**/*', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const BUILTIN_SKILL_TEXTS = import.meta.glob([
  './builtin/**/*.md',
  './builtin/**/*.txt',
  './builtin/**/*.json',
  './builtin/**/*.xml',
  './builtin/**/*.js',
  './builtin/**/*.mjs',
  './builtin/**/*.cjs',
  './builtin/**/*.ts',
  './builtin/**/*.py',
  './builtin/**/*.sh',
  './builtin/**/*.yaml',
  './builtin/**/*.yml',
  './builtin/**/*.toml',
  './builtin/**/*.ini',
  './builtin/**/*.cfg',
], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

function builtinFileEntries(skillName: string): [string, string][] {
  const prefix = `./builtin/${skillName}/`;
  return Object.entries(BUILTIN_SKILL_FILE_URLS)
    .filter(([path]) => path.startsWith(prefix))
    .map(([path, url]) => [path.slice(prefix.length), url] as [string, string]);
}

export function listBuiltinSkillFiles(skillName: string): string[] {
  const builtinSkill = BUILTIN_SKILLS.find((skill) => skill.name === skillName);
  if (!builtinSkill) throw new Error(`Builtin skill '${skillName}' not found`);
  const files = builtinFileEntries(skillName).map(([path]) => path).sort();
  const skillMd = files.indexOf('SKILL.md');
  if (skillMd >= 0) {
    files.splice(skillMd, 1);
    files.unshift('SKILL.md');
  }
  return files;
}

export async function readBuiltinSkillFile(skillName: string, file: string): Promise<
  | { skill: string; file: string; content: string; binary?: false }
  | { skill: string; file: string; binary: true; contentType: string; base64: string }
> {
  const normalized = file.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').some((part) => part === '..')) {
    throw new Error('Invalid skill file path');
  }
  const match = builtinFileEntries(skillName).find(([path]) => path === normalized);
  if (!match) throw new Error(`File '${file}' not found in skill '${skillName}'`);

  const importPath = `./builtin/${skillName}/${normalized}`;
  if (Object.prototype.hasOwnProperty.call(BUILTIN_SKILL_TEXTS, importPath)) {
    return { skill: skillName, file: normalized, content: BUILTIN_SKILL_TEXTS[importPath] };
  }

  const response = await fetch(match[1]);
  if (!response.ok) throw new Error(`Could not read '${file}' from skill '${skillName}'`);
  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return { skill: skillName, file: normalized, binary: true, contentType, base64: btoa(binary) };
}
