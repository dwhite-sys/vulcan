export type VisionCapability = true | false | 'unknown';

export interface ModelVisionMatch {
  vision: VisionCapability;
  source: 'override' | 'models.dev' | 'unknown';
  matchedModelId?: string;
}

/** Current models.dev/models.json modality schema. */
export interface CatalogModalities {
  input?: string[] | null;
  output?: string[] | null;
}

/** Legacy/provider-compatible schema retained for older cached snapshots. */
export interface CatalogArchitecture {
  modality?: string | null;
  input_modalities?: string[] | null;
  output_modalities?: string[] | null;
  tokenizer?: string | null;
  instruct_type?: string | null;
}

export interface CatalogModelRecord {
  id: string;
  name?: string | null;
  description?: string | null;
  family?: string | null;
  attachment?: boolean | null;
  reasoning?: boolean | null;
  tool_call?: boolean | null;
  structured_output?: boolean | null;
  temperature?: boolean | null;
  knowledge?: string | null;
  release_date?: string | null;
  last_updated?: string | null;
  modalities?: CatalogModalities | null;
  open_weights?: boolean | null;
  limit?: Record<string, number> | null;
  license?: string | null;
  links?: unknown[] | null;
  weights?: unknown[] | null;
  benchmarks?: unknown[] | null;

  // Historical fields retained so previously cached snapshots and older
  // models.dev/provider payloads continue to resolve without migration.
  canonical_slug?: string | null;
  hugging_face_id?: string | null;
  context_length?: number | null;
  architecture?: CatalogArchitecture | null;

  // Preserve the complete upstream record. Vulcan only consumes a subset of
  // fields today, but models.dev can add metadata without requiring a parser
  // rewrite or losing it from the local cached snapshot.
  [key: string]: unknown;
}

export interface ModelCatalogIndex {
  exact: Map<string, CatalogModelRecord>;
  aliases: Map<string, CatalogModelRecord | null>;
  modelCount: number;
}

// Backward-compatible type name used by the vision runtime. The index stores
// complete models.dev records rather than a vision-only derivative.
export type ModelVisionIndex = ModelCatalogIndex;

function normalizedId(value: string): string {
  return value.trim().toLowerCase();
}

function slugIdentity(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*$/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

/**
 * Remove only suffixes known to describe a serving route rather than the
 * underlying model. Do not strip arbitrary colon tags: Ollama-style tags such
 * as `:27b` are model identity and intentionally survive this function.
 */
function stripDeploymentDecoration(value: string): string {
  let candidate = normalizedId(value);
  candidate = candidate
    .replace(/:(?:cloud|free|online|nitro|floor)$/i, '')
    .replace(/-(?:cloud)$/i, '');
  return candidate;
}

function providerAliasCandidates(value: string): string[] {
  const candidate = stripDeploymentDecoration(value);
  if (!candidate) return [];

  const aliases: string[] = [];
  const push = (raw: string) => {
    const slug = slugIdentity(raw);
    if (slug) aliases.push(slug);
  };

  // Full provider/model identity first.
  push(candidate);

  // models.dev is provider-agnostic and uses the model author's namespace
  // (e.g. alibaba/qwen3.8-27b), while serving providers may expose a different
  // namespace (e.g. qwen/qwen3.8-27b or z-ai/glm-5.3-flash). The final path
  // component is therefore a useful provider-independent identity. It remains
  // collision-safe because aliases map to null when more than one catalog
  // record claims the same identity.
  const slash = candidate.lastIndexOf('/');
  if (slash >= 0 && slash + 1 < candidate.length) push(candidate.slice(slash + 1));

  return [...new Set(aliases)];
}

function recordAliasCandidates(record: CatalogModelRecord): string[] {
  const values: string[] = [];
  const push = (value: unknown) => {
    if (typeof value !== 'string' || !value.trim()) return;
    const slug = slugIdentity(value);
    if (slug) values.push(slug);
  };

  push(record.id);

  // Register the provider-independent leaf of the canonical models.dev ID.
  // This is what lets qwen/qwen3.8-27b safely resolve to
  // alibaba/qwen3.8-27b without hard-coding provider namespace translations.
  const normalizedRecordId = normalizedId(record.id);
  const slash = normalizedRecordId.lastIndexOf('/');
  if (slash >= 0 && slash + 1 < normalizedRecordId.length) push(normalizedRecordId.slice(slash + 1));

  push(record.canonical_slug);
  push(record.hugging_face_id);
  if (typeof record.name === 'string' && record.name.trim()) {
    push(record.name);
    const colon = record.name.indexOf(':');
    if (colon >= 0) push(record.name.slice(colon + 1));
  }
  return [...new Set(values)];
}

function addCollisionSafeAlias(aliases: Map<string, CatalogModelRecord | null>, key: string, record: CatalogModelRecord): void {
  if (!key) return;
  const previous = aliases.get(key);
  if (previous === undefined) aliases.set(key, record);
  else if (previous?.id !== record.id) aliases.set(key, null);
}

function normalizedModalities(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((item) => String(item).trim().toLowerCase())
    .filter(Boolean);
}

export function getCatalogModalities(record: CatalogModelRecord): { input: string[]; output: string[] } {
  // Current models.dev/models.json schema.
  const currentInput = normalizedModalities(record.modalities?.input);
  const currentOutput = normalizedModalities(record.modalities?.output);
  if (currentInput.length > 0 || currentOutput.length > 0) {
    return { input: currentInput, output: currentOutput };
  }

  // Historical snapshots/provider-shaped records.
  const legacyInput = normalizedModalities(record.architecture?.input_modalities);
  const legacyOutput = normalizedModalities(record.architecture?.output_modalities);
  if (legacyInput.length > 0 || legacyOutput.length > 0) {
    return { input: legacyInput, output: legacyOutput };
  }

  // Very old records sometimes expose only a compact "text+image->text"
  // architecture.modality string. Preserve support without guessing.
  const modality = record.architecture?.modality;
  if (typeof modality === 'string' && modality.trim()) {
    const [inputRaw = '', outputRaw = ''] = modality.split('->', 2);
    return {
      input: inputRaw.split('+').map((item) => item.trim().toLowerCase()).filter(Boolean),
      output: outputRaw.split('+').map((item) => item.trim().toLowerCase()).filter(Boolean),
    };
  }

  return { input: [], output: [] };
}

function explicitVision(record: CatalogModelRecord): boolean | null {
  const { input } = getCatalogModalities(record);
  if (input.length === 0) return null;
  return input.includes('image');
}

function looksLikeRecord(value: unknown): value is CatalogModelRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && typeof (value as any).id === 'string');
}

function flatModelsJsonRecords(root: Record<string, unknown>): CatalogModelRecord[] {
  const entries = Object.entries(root);
  if (entries.length === 0) return [];

  const records: CatalogModelRecord[] = [];
  for (const [modelId, modelValue] of entries) {
    if (!modelValue || typeof modelValue !== 'object' || Array.isArray(modelValue)) return [];
    const value = modelValue as Record<string, unknown>;

    // Historical provider containers also form an object-of-objects, so do not
    // mistake `{ provider: { models: {...} } }` for current models.json. A flat
    // record either carries its canonical id (the live schema does for every
    // entry) or carries recognizable model metadata while not being a provider
    // container.
    if ('models' in value) return [];
    const hasExplicitId = typeof value.id === 'string' && value.id.trim().length > 0;
    const hasModelMetadata =
      typeof value.name === 'string' ||
      typeof value.description === 'string' ||
      'modalities' in value ||
      'limit' in value ||
      'release_date' in value;
    if (!hasExplicitId && !hasModelMetadata) return [];

    // Current models.dev/models.json repeats the canonical key in `id`. Key
    // fallback keeps the parser lossless if that redundant field is ever absent.
    const id = hasExplicitId ? String(value.id) : modelId;
    if (!id.trim()) return [];
    records.push({ ...value, id } as CatalogModelRecord);
  }
  return records;
}

/**
 * Accept the live models.dev/models.json format losslessly, plus historical
 * top-level array, {data:[...]}, {models:[...]}, and provider -> models map
 * shapes retained for old caches/provider fixtures.
 */
export function collectCatalogRecords(snapshot: unknown): CatalogModelRecord[] {
  if (Array.isArray(snapshot)) return snapshot.filter(looksLikeRecord);
  if (!snapshot || typeof snapshot !== 'object') return [];

  const root = snapshot as Record<string, any>;
  if (Array.isArray(root.data)) return root.data.filter(looksLikeRecord);
  if (Array.isArray(root.models)) return root.models.filter(looksLikeRecord);

  // Detect the current flat models.json shape before historical provider-map
  // parsing. A valid flat snapshot yields one record for every top-level key.
  const flat = flatModelsJsonRecords(root);
  if (flat.length > 0) return flat;

  const records: CatalogModelRecord[] = [];
  for (const [providerId, providerValue] of Object.entries(root)) {
    if (!providerValue || typeof providerValue !== 'object') continue;
    const models = (providerValue as any).models;
    if (!models || typeof models !== 'object' || Array.isArray(models)) continue;
    for (const [modelId, modelValue] of Object.entries(models)) {
      if (!modelValue || typeof modelValue !== 'object' || Array.isArray(modelValue)) continue;
      const value = modelValue as any;
      records.push({
        ...value,
        id: typeof value.id === 'string' && value.id ? value.id : `${providerId}/${modelId}`,
      });
    }
  }
  return records;
}

export function buildModelCatalogIndex(snapshot: unknown): ModelCatalogIndex {
  const exact = new Map<string, CatalogModelRecord>();
  const aliases = new Map<string, CatalogModelRecord | null>();
  let modelCount = 0;

  for (const record of collectCatalogRecords(snapshot)) {
    const key = normalizedId(record.id);
    if (!key) continue;
    exact.set(key, record);
    for (const alias of recordAliasCandidates(record)) addCollisionSafeAlias(aliases, alias, record);
    modelCount += 1;
  }

  return { exact, aliases, modelCount };
}

export function buildModelVisionIndex(snapshot: unknown): ModelVisionIndex {
  return buildModelCatalogIndex(snapshot);
}

/**
 * Resolve exact IDs first, then collision-safe aliases derived from models.dev
 * identity/name metadata. Provider namespaces may differ from the canonical
 * author namespace, so both full and leaf identities are attempted. Any alias
 * collision fails closed to null rather than selecting an arbitrary record.
 */
export function resolveModelFromIndex(index: ModelCatalogIndex, modelId: string): CatalogModelRecord | null {
  const key = normalizedId(modelId);
  if (!key) return null;
  const exact = index.exact.get(key);
  if (exact) return exact;

  for (const alias of providerAliasCandidates(modelId)) {
    const match = index.aliases.get(alias);
    if (match) return match;
  }
  return null;
}

export function resolveVisionFromIndex(index: ModelVisionIndex, modelId: string): ModelVisionMatch {
  const record = resolveModelFromIndex(index, modelId);
  if (!record) return { vision: 'unknown', source: 'unknown' };
  const vision = explicitVision(record);
  if (vision === null) return { vision: 'unknown', source: 'unknown', matchedModelId: record.id };
  return { vision, source: 'models.dev', matchedModelId: record.id };
}
