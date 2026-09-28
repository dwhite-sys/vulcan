import type { EtnaServerProfile, EtnaKitSource, LogicalEtnaKit, EtnaSummary, KitWithTools } from '../types/vulcan';
import type { SkillFileResult } from './vulcanClient';
import { generalWS } from './ws';
import { migrateScopedNetworkValue, scopedNetworkKey } from './networkProfileScope';
import { repairToolSemanticIndex } from './toolSemanticCache';
import { reconcileEtnaHealth } from './etnaHealth';

const SERVERS_KEY = 'vulcan:etna_servers';
const ROUTES_KEY = 'vulcan:etna_routes';
const DEVICE_KEY = 'vulcan:client_device_id';

export function clientDeviceId(): string {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) { id = crypto.randomUUID(); localStorage.setItem(DEVICE_KEY, id); }
  return id;
}

function normalizeServer(raw: Partial<EtnaServerProfile>): EtnaServerProfile {
  return {
    id: raw.id || crypto.randomUUID(),
    name: raw.name || 'Etna',
    url: (raw.url || 'http://localhost:8467').replace(/\/$/, ''),
    networkPointOfView: raw.networkPointOfView === 'server' ? 'server' : 'client',
    enabled: raw.enabled !== false,
    healthy: raw.healthy === true,
    inventory: Array.isArray(raw.inventory) ? raw.inventory : [],
    ...({ skills: Array.isArray((raw as any).skills) ? (raw as any).skills : [] } as any),
  };
}

export function loadEtnaServers(): EtnaServerProfile[] {
  try {
    const raw = JSON.parse(migrateScopedNetworkValue(SERVERS_KEY) || 'null');
    if (Array.isArray(raw) && raw.length) return raw.map(normalizeServer);
  } catch { /* seed below */ }
  const seeded = [normalizeServer({ id: crypto.randomUUID(), name: 'Local', url: 'http://localhost:8467', networkPointOfView: 'client', enabled: true })];
  localStorage.setItem(scopedNetworkKey(SERVERS_KEY), JSON.stringify(seeded));
  return seeded;
}

export function saveEtnaServers(servers: EtnaServerProfile[]): EtnaServerProfile[] {
  const normalized = servers.map(normalizeServer);
  localStorage.setItem(scopedNetworkKey(SERVERS_KEY), JSON.stringify(normalized));
  window.dispatchEvent(new CustomEvent('vulcan:etna-changed'));
  return normalized;
}

function loadRoutes(): Record<string, string> {
  try { return JSON.parse(migrateScopedNetworkValue(ROUTES_KEY) || '{}') || {}; } catch { return {}; }
}
function saveRoutes(routes: Record<string, string>) { localStorage.setItem(scopedNetworkKey(ROUTES_KEY), JSON.stringify(routes)); }

function norm(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, ''); }
function similarity(a: string, b: string): number {
  const x = norm(a), y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  // Dice coefficient over bigrams is deterministic and conservative enough for naming drift.
  const grams = (s: string) => { const out: string[] = []; for (let i=0;i<Math.max(1,s.length-1);i++) out.push(s.slice(i,i+2)); return out; };
  const aa=grams(x), bb=grams(y); const used=new Set<number>(); let hits=0;
  for (const g of aa) { const j=bb.findIndex((v,i)=>v===g && !used.has(i)); if (j>=0) { used.add(j); hits++; } }
  return (2*hits)/(aa.length+bb.length);
}

const ETNA_TRANSIENT_HTTP = new Set([408, 425, 429, 500, 502, 503, 504]);

async function clientFetch(url: string, init: RequestInit, timeoutMs = 10_000, retrySafe = false): Promise<Response> {
  const attempts = retrySafe ? 2 : 1;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (!retrySafe || !ETNA_TRANSIENT_HTTP.has(response.status) || attempt + 1 >= attempts) return response;
      lastError = new Error(`Transient Etna HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt + 1 >= attempts) throw error;
    } finally {
      window.clearTimeout(timer);
    }
    await new Promise((resolve) => window.setTimeout(resolve, 100));
  }
  throw lastError instanceof Error ? lastError : new Error('Etna request failed');
}

function sameLogicalKit(a: KitWithTools, b: KitWithTools): boolean {
  if (similarity(a.kit_name, b.kit_name) < 0.82 || a.tools.length !== b.tools.length) return false;
  const used = new Set<number>();
  for (const tool of a.tools) {
    let best = -1, bestScore = 0;
    b.tools.forEach((candidate, index) => {
      if (used.has(index)) return;
      const score = similarity(tool.name, candidate.name);
      if (score > bestScore) { bestScore = score; best = index; }
    });
    if (best < 0 || bestScore < 0.82) return false;
    used.add(best);
  }
  return true;
}

async function request(server: EtnaServerProfile, path: string, method='GET', body?: any): Promise<any> {
  if (server.networkPointOfView === 'client') {
    const response = await clientFetch(server.url.replace(/\/$/, '') + path, {
      method, headers: { 'Content-Type': 'application/json' },
      body: body == null || method === 'GET' ? undefined : JSON.stringify(body),
    }, 10_000, method === 'GET');
    const text = await response.text();
    if (!response.ok) throw new Error(`Etna HTTP ${response.status}: ${text || response.statusText}`);
    try { return text ? JSON.parse(text) : {}; } catch { return { result: text }; }
  }
  return generalWS.send('network/http-json', { url: server.url.replace(/\/$/, '') + path, method, body });
}

async function discover(server: EtnaServerProfile): Promise<EtnaServerProfile> {
  if (!server.enabled) return { ...server, healthy: false };

  // Connectivity is intentionally defined by the lightweight registry probe, not by
  // every downstream inventory/skill/cache operation succeeding. A reachable Etna
  // server must stay visually online even if one kit has stale metadata or an optional
  // endpoint is temporarily broken.
  let listed: any;
  try {
    listed = await request(server, '/list_kits');
  } catch {
    // Keep the last-known inventory on a genuine endpoint outage; offline != conflict.
    return { ...server, healthy: false };
  }

  const names: string[] = Array.isArray(listed?.kits) ? listed.kits : [];
  const previousByName = new Map((server.inventory || []).map((kit) => [kit.kit_name, kit] as const));
  const inventory: KitWithTools[] = [];

  for (const name of names) {
    try {
      const [kit, tools] = await Promise.all([
        request(server, '/inspect_kit', 'POST', { kit: name }),
        request(server, '/list_tools_in_kit', 'POST', { kit: name }),
      ]);
      const filename = String(kit?.filename || '');
      const stem = filename.replace(/\.py$/i, '') || String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_');
      const skillName = typeof kit?.skill === 'string' && kit.skill ? kit.skill : null;
      const skillSource = skillName
        ? (typeof kit?.skill_source === 'string' && kit.skill_source ? kit.skill_source : `kits/${stem}`)
        : null;
      inventory.push({
        kit_name: kit?.kit_name || name,
        kit_description: kit?.kit_description || '',
        filename,
        enabled: kit?.enabled !== false,
        // Vulcan stores the stable Etna package source here. The human-facing
        // skill name travels as a descriptor and may differ from the kit stem.
        skill: skillSource,
        ...({ skill_name: skillName } as any),
        tools: Array.isArray(tools?.tools) ? tools.tools : [],
      } as KitWithTools);
    } catch (error) {
      // A single broken kit should not make a reachable Etna server appear offline.
      // Reuse that kit's last-known metadata when possible and let the next refresh
      // self-repair it.
      const previous = previousByName.get(name);
      if (previous) inventory.push(previous);
      console.warn(`[Vulcan] Could not refresh Etna kit ${name}; keeping last-known metadata`, error);
    }
  }

  let skills: any[] = Array.isArray((server as any).skills) ? (server as any).skills : [];
  try {
    const payload = await request(server, '/list_skills');
    skills = (Array.isArray(payload?.skills) ? payload.skills : []).map((skill: any) => ({
      ...skill,
      // Older Etna versions omitted source because /list_skills contained only
      // standalone skills. Preserve compatibility while making the contract explicit.
      source: typeof skill?.source === 'string' && skill.source ? skill.source : 'skills',
    }));
  } catch { /* optional; keep last-known skills */ }

  return { ...server, healthy: true, inventory, ...({ skills } as any) };
}

function logicalId(kit: KitWithTools): string {
  const names = kit.tools.map((tool) => norm(tool.name)).sort().join(',');
  return `${norm(kit.kit_name)}:${kit.tools.length}:${names}`;
}

export function deriveEtnaState(servers: EtnaServerProfile[]) {
  const enabled = servers.filter((s) => s.enabled);
  const groups: { kit: KitWithTools; sources: EtnaKitSource[]; variants: { serverId: string; kit: KitWithTools }[] }[] = [];
  for (const server of enabled) {
    for (const kit of server.inventory || []) {
      let group = groups.find((candidate) => sameLogicalKit(candidate.kit, kit));
      if (!group) { group = { kit, sources: [], variants: [] }; groups.push(group); }
      group.sources.push({
        serverId: server.id, name: server.name, url: server.url,
        networkPointOfView: server.networkPointOfView,
        clientId: server.networkPointOfView === 'client' ? clientDeviceId() : null,
        healthy: server.healthy, enabled: server.enabled,
      });
      group.variants.push({ serverId: server.id, kit });
    }
  }
  const routes = loadRoutes();
  const validLogicalIds = new Set<string>();
  const kits: LogicalEtnaKit[] = groups.map(({kit,sources,variants}) => {
    const id = logicalId(kit); validLogicalIds.add(id);
    const selected = routes[id];
    const selectedSource = selected ? sources.find((source)=>source.serverId===selected) : undefined;
    const unresolved = sources.length > 1 && !selectedSource;
    const effective = selectedSource || (sources.length === 1 ? sources[0] : null);
    // A deduplicated logical kit must expose the schema/description from its
    // selected source. Otherwise route changes can silently retain stale tools.
    const effectiveKit = effective ? (variants.find((variant)=>variant.serverId===effective.serverId)?.kit || kit) : kit;
    return { ...effectiveKit, logical_id:id, sources, selected_server_id:selectedSource?.serverId ?? null,
      unresolved_conflict: unresolved, effective_source: effective } as LogicalEtnaKit;
  });
  // Drop routes whose logical kit disappeared entirely; invalid selected source remains unresolved if 2+ remain.
  const configuredIds = new Set(servers.map((server) => server.id));
  const cleaned = Object.fromEntries(Object.entries(routes).filter(([id, serverId])=>validLogicalIds.has(id) && configuredIds.has(serverId)));
  saveRoutes(cleaned);
  const resolved = kits.filter((kit)=>!kit.unresolved_conflict && kit.effective_source);
  const conflictServerIds = Array.from(new Set(kits.filter(k=>k.unresolved_conflict).flatMap(k=>k.sources.map(s=>s.serverId))));
  const summary: EtnaSummary = {
    servers: servers.length, configured: servers.length,
    healthy: servers.filter((s)=>s.enabled && s.healthy).length,
    kits: resolved.length, tools: resolved.reduce((sum,k)=>sum+k.tools.length,0), conflictServerIds,
  };
  const seenSkills = new Set<string>();
  const skills: any[] = [];
  // Standalone skills follow the Etna server on which they were discovered.
  for (const server of servers) {
    const effective_source: EtnaKitSource = {
      serverId: server.id, name: server.name, url: server.url,
      networkPointOfView: server.networkPointOfView,
      clientId: server.networkPointOfView === 'client' ? clientDeviceId() : null,
      healthy: server.healthy, enabled: server.enabled,
    };
    for (const skill of (((server as any).skills || []) as any[])) {
      const key = `skills:${String(skill?.name || '').toLowerCase()}`;
      if (!skill?.name || seenSkills.has(key)) continue;
      seenSkills.add(key);
      skills.push({ ...skill, source: 'skills', effective_source });
    }
  }
  // Paired skills follow the logical kit's selected/effective source, so a
  // duplicate kit route and its skill can never diverge onto different Etna servers.
  for (const kit of resolved) {
    const source = kit.effective_source;
    if (!source || !kit.skill) continue;
    const sourceServerProfile = servers.find((server) => server.id === source.serverId);
    const sourceKit = sourceServerProfile?.inventory?.find((candidate: any) =>
      candidate.kit_name === kit.kit_name && candidate.skill === kit.skill);
    const skillName = (sourceKit as any)?.skill_name;
    if (!skillName) continue;
    const key = `${kit.skill}:${String(skillName).toLowerCase()}`;
    if (seenSkills.has(key)) continue;
    seenSkills.add(key);
    skills.push({ name: skillName, description: '', source: kit.skill, effective_source: source });
  }
  return { servers, kits, summary, skills };
}

export async function runEtnaTool(source: EtnaKitSource, tool: string, arguments_: any): Promise<any> {
  const server: EtnaServerProfile = {
    id: source.serverId, name: source.name, url: source.url, networkPointOfView: source.networkPointOfView,
    enabled: source.enabled, healthy: source.healthy,
  };
  return request(server, '/run_tool', 'POST', { tool, arguments: arguments_ });
}


export type EtnaHealthProbeResult = ReturnType<typeof deriveEtnaState> & {
  changed: boolean;
  recoveredServerIds: string[];
  offlineServerIds: string[];
};

async function probeEtnaServer(server: EtnaServerProfile, timeoutMs = 3000): Promise<boolean> {
  if (!server.enabled) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request(server, '/list_kits').then(() => true, () => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function probeEtnaHealth(): Promise<EtnaHealthProbeResult> {
  const current = loadEtnaServers();
  const statuses = await Promise.all(current.map(async (server) => [server.id, await probeEtnaServer(server)] as const));
  const reconciled = reconcileEtnaHealth(current, Object.fromEntries(statuses));
  if (reconciled.changed) saveEtnaServers(reconciled.servers);
  return {
    ...deriveEtnaState(reconciled.servers),
    changed: reconciled.changed,
    recoveredServerIds: reconciled.recoveredServerIds,
    offlineServerIds: reconciled.offlineServerIds,
  };
}

export async function refreshEtnaState() {
  const discovered = await Promise.all(loadEtnaServers().map(discover));
  saveEtnaServers(discovered);
  const state = deriveEtnaState(discovered);
  const resolved = state.kits.filter((kit) => !kit.unresolved_conflict && kit.effective_source) as KitWithTools[];

  // Semantic search is derived/cache state. Failure to repair it must never turn a
  // healthy Etna registry into an apparent connection failure. Lexical/tool discovery
  // remains usable and the semantic cache will retry on a later refresh/startup.
  let semanticToolIndex = null;
  try {
    semanticToolIndex = await repairToolSemanticIndex(resolved, true);
  } catch (error) {
    console.warn('[Vulcan] Etna semantic tool index repair failed; continuing without semantic cache', error);
  }
  return { ...state, semanticToolIndex };
}

export async function setEtnaRoute(logicalId: string, serverId: string | null) {
  const routes = loadRoutes();
  if (serverId) routes[logicalId] = serverId; else delete routes[logicalId];
  saveRoutes(routes);
  const state = deriveEtnaState(loadEtnaServers());
  const resolved = state.kits.filter((kit) => !kit.unresolved_conflict && kit.effective_source) as KitWithTools[];
  const semanticToolIndex = await repairToolSemanticIndex(resolved, true);
  return { ...state, semanticToolIndex };
}


function sourceServer(source: EtnaKitSource): EtnaServerProfile {
  return { id: source.serverId, name: source.name, url: source.url, networkPointOfView: source.networkPointOfView,
    enabled: source.enabled, healthy: source.healthy };
}

export async function listEtnaSkillFiles(source: EtnaKitSource, skill: string, skillSource?: string): Promise<{ skill: string; files: string[] }> {
  return request(sourceServer(source), '/list_skill_files', 'POST', { skill, source: skillSource });
}

export async function readEtnaSkill(source: EtnaKitSource, skill: string, skillSource?: string): Promise<{ name: string; body: string }> {
  return request(sourceServer(source), '/read_skill', 'POST', { skill, source: skillSource });
}

export async function readEtnaSkillFile(source: EtnaKitSource, skill: string, file: string, skillSource?: string): Promise<SkillFileResult> {
  const server = sourceServer(source);
  const url = server.url.replace(/\/$/, '') + '/read_skill_file';
  if (server.networkPointOfView === 'server') {
    const result = await generalWS.send('network/http-bytes', { url, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { skill, file, source: skillSource } });
    const contentType = String(result?.contentType || 'application/octet-stream');
    const base64 = String(result?.base64 || '');
    if (contentType.includes('application/json')) {
      const text = atob(base64);
      return JSON.parse(text) as SkillFileResult;
    }
    return { skill, file, binary: true, contentType, base64 };
  }
  const response = await clientFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ skill, file, source: skillSource }) });
  if (!response.ok) throw new Error(`Etna HTTP ${response.status}: ${await response.text() || response.statusText}`);
  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  if (contentType.includes('application/json')) return response.json();
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { skill, file, binary: true, contentType, base64: btoa(binary) };
}
