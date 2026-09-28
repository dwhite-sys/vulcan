import { vulcanClient, type SkillDescriptor, type SkillFileResult } from './vulcanClient';
import { getActiveBuiltinSkills, listBuiltinSkillFiles, readBuiltinSkillFile } from '../skills/builtins';

export interface SkillRuntimeSettings {
  cliWorkspaceEnabled: boolean;
  panelsEnabled: boolean;
  disabledVulcanSkills?: string[];
}

export interface SkillAvailabilityContext {
  settings: SkillRuntimeSettings;
  enabledGeneralSkills: { name: string; description?: string; source?: string }[];
  enabledKits: string[];
}

async function enabledKitSources(enabledKits: string[]): Promise<Set<string>> {
  const sources = new Set<string>();
  await Promise.all(enabledKits.map(async (kitName) => {
    try {
      const kit: any = await vulcanClient.inspectKit(kitName);
      if (typeof kit?.skill === 'string' && kit.skill.startsWith('kits/')) sources.add(kit.skill);
    } catch {
      // An unavailable kit should not make skill discovery fail globally.
    }
  }));
  return sources;
}

export async function listAvailableSkills(ctx: SkillAvailabilityContext): Promise<SkillDescriptor[]> {
  const builtins: SkillDescriptor[] = getActiveBuiltinSkills(ctx.settings).map(({ name, description }) => ({
    name,
    description,
    source: 'vulcan',
  }));

  let etna: SkillDescriptor[] = [];
  try {
    etna = await vulcanClient.listSkills();
  } catch {
    return builtins;
  }

  const generalNames = new Set(ctx.enabledGeneralSkills.map((skill) => skill.name));
  const kitSources = await enabledKitSources(ctx.enabledKits);
  const visibleEtna = etna.filter((skill) => {
    if (skill.source === 'skills') return generalNames.has(skill.name);
    if (skill.source.startsWith('kits/')) return kitSources.has(skill.source);
    return false;
  });

  return [...builtins, ...visibleEtna].sort((a, b) => a.name.localeCompare(b.name));
}

export async function searchAvailableSkills(query: string, ctx: SkillAvailabilityContext): Promise<SkillDescriptor[]> {
  const keywords = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (keywords.length === 0) return [];

  const builtins = getActiveBuiltinSkills(ctx.settings)
    .map(({ name, description }) => ({ name, description, source: 'vulcan' } as SkillDescriptor))
    .map((skill) => ({
      skill,
      score: keywords.reduce((score, keyword) => {
        const haystack = `${skill.name} ${skill.description}`.toLowerCase();
        return score + (haystack.includes(keyword) ? 1 : 0);
      }, 0),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ skill }) => skill);

  let etnaMatches: SkillDescriptor[] = [];
  try {
    etnaMatches = await vulcanClient.searchSkills(query);
  } catch {
    return builtins;
  }

  const generalNames = new Set(ctx.enabledGeneralSkills.map((skill) => skill.name));
  const kitSources = await enabledKitSources(ctx.enabledKits);
  const visibleEtna = etnaMatches.filter((skill) => {
    if (skill.source === 'skills') return generalNames.has(skill.name);
    if (skill.source.startsWith('kits/')) return kitSources.has(skill.source);
    return false;
  });

  return [...builtins, ...visibleEtna];
}

async function resolveAvailableSkill(name: string, source: string | undefined, ctx: SkillAvailabilityContext): Promise<SkillDescriptor | null> {
  const available = await listAvailableSkills(ctx);
  if (source) return available.find((skill) => skill.name === name && skill.source === source) ?? null;
  return available.find((skill) => skill.name === name) ?? null;
}

export async function readAvailableSkill(name: string, source: string | undefined, ctx: SkillAvailabilityContext) {
  const descriptor = await resolveAvailableSkill(name, source, ctx);
  if (!descriptor) throw new Error(`Skill '${name}' is not available in this chat`);

  if (descriptor.source === 'vulcan') {
    const builtin = getActiveBuiltinSkills(ctx.settings).find((skill) => skill.name === descriptor.name);
    if (!builtin) throw new Error(`Skill '${name}' is not available in this chat`);
    return { name: descriptor.name, source: descriptor.source, body: builtin.body };
  }

  const result = await vulcanClient.readSkill(descriptor.name);
  return { ...result, source: descriptor.source };
}

export async function listAvailableSkillFiles(name: string, source: string | undefined, ctx: SkillAvailabilityContext) {
  const descriptor = await resolveAvailableSkill(name, source, ctx);
  if (!descriptor) throw new Error(`Skill '${name}' is not available in this chat`);

  if (descriptor.source === 'vulcan') {
    return { skill: descriptor.name, source: descriptor.source, files: listBuiltinSkillFiles(descriptor.name) };
  }

  const result = await vulcanClient.listSkillFiles(descriptor.name);
  return { ...result, source: descriptor.source };
}

export async function readAvailableSkillFile(name: string, file: string, source: string | undefined, ctx: SkillAvailabilityContext): Promise<SkillFileResult & { source: string }> {
  const descriptor = await resolveAvailableSkill(name, source, ctx);
  if (!descriptor) throw new Error(`Skill '${name}' is not available in this chat`);

  if (descriptor.source === 'vulcan') {
    const result = await readBuiltinSkillFile(descriptor.name, file);
    return { ...result, source: descriptor.source };
  }

  const result = await vulcanClient.readSkillFile(descriptor.name, file);
  return { ...result, source: descriptor.source };
}
