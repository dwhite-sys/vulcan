import type { SkillMeta } from '../components/SkillToggleMenu';
import { listBuiltinSkillFiles, readBuiltinSkillFile } from '../skills/builtins';
import { vulcanClient, type SkillFileResult } from './vulcanClient';

export interface SkillFileTreeNode {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  children?: SkillFileTreeNode[];
}

type SkillPackageDescriptor = Pick<SkillMeta, 'name' | 'source'>;

const DISPLAY_ACRONYMS: Record<string, string> = {
  api: 'API',
  cli: 'CLI',
  etna: 'Etna',
  html: 'HTML',
  http: 'HTTP',
  llm: 'LLM',
  mcp: 'MCP',
  ui: 'UI',
  url: 'URL',
};

export function formatSkillDisplayName(name: string): string {
  return name
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => DISPLAY_ACRONYMS[word.toLowerCase()] ?? `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(' ');
}

export function stripSkillFrontmatter(content: string): string {
  const normalized = content.replace(/^\uFEFF/, '');
  if (!normalized.startsWith('---')) return content;
  const match = normalized.match(/^---[\t ]*\r?\n[\s\S]*?\r?\n---[\t ]*(?:\r?\n|$)/);
  return match ? normalized.slice(match[0].length).replace(/^\s+/, '') : content;
}

function sortSkillFileTree(nodes: SkillFileTreeNode[], root = false): void {
  nodes.sort((left, right) => {
    if (root && left.path === 'SKILL.md') return -1;
    if (root && right.path === 'SKILL.md') return 1;
    if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1;
    return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
  });
  for (const node of nodes) {
    if (node.children) sortSkillFileTree(node.children);
  }
}

export function buildSkillFileTree(files: string[]): SkillFileTreeNode[] {
  const roots: SkillFileTreeNode[] = [];

  for (const file of files) {
    if (typeof file !== 'string') continue;
    const normalized = file.replace(/\\/g, '/').replace(/^\.\//, '');
    const parts = normalized.split('/');
    if (!normalized || normalized.startsWith('/') || parts.some((part) => !part || part === '.' || part === '..' || part.includes('\0'))) {
      continue;
    }

    let siblings = roots;
    let conflict = false;
    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index];
      const kind = index === parts.length - 1 ? 'file' : 'directory';
      const existing = siblings.find((node) => node.name === name);
      if (existing) {
        if (existing.kind !== kind) {
          conflict = true;
          break;
        }
        if (kind === 'directory') siblings = existing.children!;
        continue;
      }

      const node: SkillFileTreeNode = {
        name,
        path: parts.slice(0, index + 1).join('/'),
        kind,
        ...(kind === 'directory' ? { children: [] } : {}),
      };
      siblings.push(node);
      if (kind === 'directory') siblings = node.children!;
    }
    if (conflict) continue;
  }

  sortSkillFileTree(roots, true);
  return roots;
}

export async function listSkillPackageFiles(skill: SkillPackageDescriptor): Promise<string[]> {
  if (skill.source === 'vulcan') return listBuiltinSkillFiles(skill.name);
  try {
    return (await vulcanClient.listSkillFiles(skill.name)).files;
  } catch {
    // Etna releases predating the package-file protocol can still expose the
    // skill's primary document. Represent that legacy document honestly as the
    // package's single SKILL.md child.
    await vulcanClient.readSkill(skill.name);
    return ['SKILL.md'];
  }
}

export async function readSkillPackageFile(skill: SkillPackageDescriptor, file: string): Promise<SkillFileResult> {
  if (skill.source === 'vulcan') return readBuiltinSkillFile(skill.name, file);
  try {
    return await vulcanClient.readSkillFile(skill.name, file);
  } catch (error) {
    if (file !== 'SKILL.md') throw error;
    const legacy = await vulcanClient.readSkill(skill.name);
    return { skill: skill.name, file: 'SKILL.md', content: legacy.body };
  }
}
