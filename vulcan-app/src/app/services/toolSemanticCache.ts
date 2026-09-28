import type { KitWithTools } from '../types/vulcan';
import { activeVulcanProfileScope } from './networkProfileScope';
import { generalWS } from './ws';
import { canonicalToolDocument } from './toolSemanticDocument';

const SCHEMA_VERSION = 1;
const FALLBACK_KEY_PREFIX = 'vulcan:semantic_tool_cache:';
const EMBED_BATCH = 64;

interface DiskEntry { document: string; vector: number[]; }
interface DiskCache {
  schemaVersion: number;
  endpoint: string;
  model: string;
  dimensions: number;
  catalogHash: string;
  updatedAt: string;
  entries: Record<string, DiskEntry>;
}

export interface ToolSemanticRuntimeIndex {
  schemaVersion: 1;
  model: string;
  dimensions: number;
  catalogHash: string;
  complete: boolean;
  vectors: Record<string, number[]>;
}

let current: { endpoint: string; catalogHash: string; index: ToolSemanticRuntimeIndex } | null = null;
let inFlight: Promise<ToolSemanticRuntimeIndex> | null = null;
let inFlightKey = '';

async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function buildCatalog(kits: KitWithTools[]) {
  const byHash = new Map<string, string>();
  for (const kit of kits) {
    for (const tool of kit.tools ?? []) {
      const document = canonicalToolDocument(kit.kit_name, tool);
      if (!document) continue;
      byHash.set(await sha256(document), document);
    }
  }
  const hashes = Array.from(byHash.keys()).sort();
  const catalogHash = await sha256(hashes.join('\n'));
  return { byHash, hashes, catalogHash };
}

function validVector(value: unknown, dimensions: number): value is number[] {
  return Array.isArray(value) && value.length === dimensions && value.every((item) => typeof item === 'number' && Number.isFinite(item));
}

function fallbackKey(endpoint: string) { return FALLBACK_KEY_PREFIX + encodeURIComponent(endpoint); }

async function readDisk(endpoint: string): Promise<DiskCache | null> {
  const native = (window as any).electronAPI?.semanticToolCache;
  if (typeof native?.read === 'function') {
    try { return await native.read(endpoint) as DiskCache | null; } catch { return null; }
  }
  try {
    const raw = localStorage.getItem(fallbackKey(endpoint));
    return raw ? JSON.parse(raw) as DiskCache : null;
  } catch { return null; }
}

async function writeDisk(endpoint: string, value: DiskCache): Promise<void> {
  const native = (window as any).electronAPI?.semanticToolCache;
  if (typeof native?.write === 'function') {
    const result = await native.write(endpoint, value);
    if (!result?.ok) throw new Error('Native semantic tool cache write failed');
    return;
  }
  // Browser fallback. Electron uses the native atomic file store above.
  localStorage.setItem(fallbackKey(endpoint), JSON.stringify(value));
}

function runtimeFrom(cache: DiskCache, hashes: string[], complete: boolean): ToolSemanticRuntimeIndex {
  const vectors: Record<string, number[]> = {};
  for (const hash of hashes) {
    const entry = cache.entries[hash];
    if (entry && validVector(entry.vector, cache.dimensions)) vectors[hash] = entry.vector;
  }
  return { schemaVersion: 1, model: cache.model, dimensions: cache.dimensions,
    catalogHash: cache.catalogHash, complete, vectors };
}

async function reconcile(kits: KitWithTools[], forceServerCheck = false): Promise<ToolSemanticRuntimeIndex> {
  const endpoint = activeVulcanProfileScope();
  const catalog = await buildCatalog(kits);
  if (!forceServerCheck && current && current.endpoint === endpoint && current.catalogHash === catalog.catalogHash && current.index.complete) {
    return current.index;
  }

  // Even on a disk-cache hit, ask the authenticated server which warmed encoder
  // it is running. A model/dimension change invalidates every old vector cleanly.
  const info = await generalWS.send('semantic/embed', { texts: [] });
  const model = String(info?.model || '');
  const dimensions = Number(info?.dimensions || 0);
  if (!model || !Number.isInteger(dimensions) || dimensions <= 0) throw new Error('Vulcan semantic embedder did not report a valid model');

  const loaded = await readDisk(endpoint);
  const compatible = loaded?.schemaVersion === SCHEMA_VERSION && loaded.endpoint === endpoint
    && loaded.model === model && loaded.dimensions === dimensions && loaded.entries && typeof loaded.entries === 'object';
  const entries: Record<string, DiskEntry> = {};
  const missing: { hash: string; document: string }[] = [];

  for (const hash of catalog.hashes) {
    const document = catalog.byHash.get(hash)!;
    const cached = compatible ? loaded!.entries[hash] : undefined;
    if (cached?.document === document && validVector(cached.vector, dimensions)) entries[hash] = cached;
    else missing.push({ hash, document });
  }

  // Missing/changed documents are the only corpus text ever embedded. Removed
  // documents simply never enter `entries`, so the next atomic write prunes them.
  for (let offset = 0; offset < missing.length; offset += EMBED_BATCH) {
    const batch = missing.slice(offset, offset + EMBED_BATCH);
    const response = await generalWS.send('semantic/embed', { texts: batch.map((item) => item.document) });
    if (response?.model !== model || Number(response?.dimensions) !== dimensions || !Array.isArray(response?.vectors)) {
      throw new Error('Vulcan semantic embedder changed during cache reconciliation');
    }
    if (response.vectors.length !== batch.length) throw new Error('Vulcan semantic embedder returned an incomplete vector batch');
    batch.forEach((item, index) => {
      const vector = response.vectors[index];
      if (!validVector(vector, dimensions)) throw new Error('Vulcan semantic embedder returned an invalid vector');
      entries[item.hash] = { document: item.document, vector };
    });
  }

  const loadedHashes = compatible ? Object.keys(loaded!.entries).sort() : [];
  const needsWrite = !compatible || missing.length > 0 || loaded!.catalogHash !== catalog.catalogHash
    || loadedHashes.length !== catalog.hashes.length || loadedHashes.some((hash, index) => hash !== catalog.hashes[index]);
  const cache: DiskCache = needsWrite ? {
    schemaVersion: SCHEMA_VERSION, endpoint, model, dimensions,
    catalogHash: catalog.catalogHash, updatedAt: new Date().toISOString(), entries,
  } : loaded!;
  if (needsWrite) await writeDisk(endpoint, cache);
  const index = runtimeFrom(cache, catalog.hashes, Object.keys(entries).length === catalog.hashes.length);
  current = { endpoint, catalogHash: catalog.catalogHash, index };
  return index;
}

export async function ensureToolSemanticIndex(kits: KitWithTools[], forceServerCheck = false): Promise<ToolSemanticRuntimeIndex> {
  const endpoint = activeVulcanProfileScope();
  const catalog = await buildCatalog(kits);
  const key = `${endpoint}:${catalog.catalogHash}`;
  if (!forceServerCheck && current && current.endpoint === endpoint && current.catalogHash === catalog.catalogHash && current.index.complete) return current.index;
  // Verification and ordinary repair for the same catalog share one flight.
  // A Send racing startup verification must not launch a second embedding pass.
  const flightKey = key;
  if (inFlight && inFlightKey === flightKey) return inFlight;
  inFlightKey = flightKey;
  inFlight = reconcile(kits, forceServerCheck).finally(() => { if (inFlightKey === flightKey) { inFlight = null; inFlightKey = ''; } });
  return inFlight;
}

export async function repairToolSemanticIndex(kits: KitWithTools[], forceServerCheck = false): Promise<ToolSemanticRuntimeIndex | null> {
  try { return await ensureToolSemanticIndex(kits, forceServerCheck); }
  catch (error) {
    console.warn('[Vulcan] Could not reconcile semantic tool cache; search_tools will use lexical ranking until repaired.', error);
    return null;
  }
}

