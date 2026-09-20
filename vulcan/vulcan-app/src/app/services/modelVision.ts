import {
  buildModelVisionIndex,
  resolveModelFromIndex,
  resolveVisionFromIndex,
  getCatalogModalities,
  type CatalogModelRecord,
  type ModelVisionIndex,
  type ModelVisionMatch,
  type VisionCapability,
} from './modelVisionCatalog';
import { generalWS } from './ws';

const CATALOG_URL = 'https://models.dev/models.json';
const DB_NAME = 'vulcan-model-capabilities';
const DB_VERSION = 1;
const STORE = 'catalogs';
const CATALOG_KEY = 'models.dev';
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const OVERRIDES_KEY = 'vulcan:model-vision-overrides:v1';

interface CachedCatalog {
  key: typeof CATALOG_KEY;
  fetchedAt: number;
  snapshot: unknown;
}

let index: ModelVisionIndex = buildModelVisionIndex(null);
let loaded = false;
let refreshPromise: Promise<void> | null = null;

function notifyCatalogUpdated(): void {
  window.dispatchEvent(new CustomEvent('vulcan:model-catalog-updated'));
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open model capability cache'));
  });
}

async function readCachedCatalog(): Promise<CachedCatalog | null> {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(CATALOG_KEY);
      request.onsuccess = () => resolve((request.result as CachedCatalog | undefined) ?? null);
      request.onerror = () => reject(request.error ?? new Error('Could not read model capability cache'));
    });
  } finally {
    db.close();
  }
}

async function writeCachedCatalog(value: CachedCatalog): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Could not write model capability cache'));
      tx.onabort = () => reject(tx.error ?? new Error('Model capability cache write aborted'));
    });
  } finally {
    db.close();
  }
}

function readOverrides(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(OVERRIDES_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === 'boolean')) as Record<string, boolean>;
  } catch {
    return {};
  }
}

export function setModelVisionOverride(modelId: string, vision: boolean | null): void {
  const key = modelId.trim().toLowerCase();
  if (!key) return;
  const overrides = readOverrides();
  if (vision === null) delete overrides[key];
  else overrides[key] = vision;
  localStorage.setItem(OVERRIDES_KEY, JSON.stringify(overrides));
}

export function getModelVision(modelId: string): ModelVisionMatch {
  const key = modelId.trim().toLowerCase();
  const override = readOverrides()[key];
  if (typeof override === 'boolean') return { vision: override, source: 'override', matchedModelId: modelId };
  return resolveVisionFromIndex(index, modelId);
}

export function isVisionModel(modelId: string): VisionCapability {
  return getModelVision(modelId).vision;
}

export function getModelCatalogRecord(modelId: string): CatalogModelRecord | null {
  return resolveModelFromIndex(index, modelId);
}

export function getModelDisplayName(modelId: string): string | null {
  const record = getModelCatalogRecord(modelId);
  return typeof record?.name === 'string' && record.name.trim() ? record.name.trim() : null;
}

export function getModelModalities(modelId: string): { input: string[]; output: string[] } | null {
  const record = getModelCatalogRecord(modelId);
  return record ? getCatalogModalities(record) : null;
}

export async function loadCachedModelVisionCatalog(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const cached = await readCachedCatalog();
    if (cached?.snapshot) {
      index = buildModelVisionIndex(cached.snapshot);
      notifyCatalogUpdated();
    }
  } catch (error) {
    console.warn('[Vulcan] Could not load cached model capability catalog; continuing with unknown capabilities', error);
  }
}

async function fetchModelVisionSnapshot(): Promise<unknown> {
  const nativeFetch = (window as any).electronAPI?.modelCatalog?.fetch;
  if (typeof nativeFetch === 'function') return nativeFetch();
  // Browser/dev fallback. Desktop production deliberately bypasses this path so
  // a large catalog response never competes with provider streaming on General WS.
  return generalWS.send('network/http-json', { url: CATALOG_URL, method: 'GET' });
}

export async function refreshModelVisionCatalog(force = false): Promise<void> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    await loadCachedModelVisionCatalog();

    let cached: CachedCatalog | null = null;
    try { cached = await readCachedCatalog(); } catch { /* cache remains optional */ }
    if (!force && cached && Date.now() - cached.fetchedAt < REFRESH_INTERVAL_MS) return;

    try {
      // models.dev intentionally does not expose browser CORS for its JSON
      // catalog. Electron fetches it directly in the main process; browser/dev
      // builds fall back to Vulcan's authenticated transient HTTP helper.
      const snapshot: unknown = await fetchModelVisionSnapshot();
      const nextIndex = buildModelVisionIndex(snapshot);
      // Reject obviously partial/error payloads rather than replacing a known-good
      // complete snapshot. The public catalog contains far more than this threshold.
      if (nextIndex.modelCount < 50) throw new Error(`models.dev snapshot contained only ${nextIndex.modelCount} usable model records`);

      // Store the COMPLETE upstream snapshot, not just queried models or a derived subset.
      // Only switch the in-memory index after the snapshot has been validated.
      await writeCachedCatalog({ key: CATALOG_KEY, fetchedAt: Date.now(), snapshot });
      index = nextIndex;
      notifyCatalogUpdated();
    } catch (error) {
      console.warn('[Vulcan] Model capability refresh failed; keeping the last complete local snapshot', error);
    }
  })().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

export function installModelVisionCatalogRefresh(): void {
  void loadCachedModelVisionCatalog().then(() => refreshModelVisionCatalog(false));
  // Startup can begin before the authenticated Vulcan transport is ready. Retry
  // when it becomes usable; cached metadata remains available in the meantime.
  generalWS.onConnectionChange((connected) => {
    if (connected) void refreshModelVisionCatalog(false);
  });
  window.addEventListener('online', () => { void refreshModelVisionCatalog(false); });
}
