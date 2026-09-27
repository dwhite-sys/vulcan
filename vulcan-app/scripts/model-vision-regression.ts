import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildModelVisionIndex,
  collectCatalogRecords,
  getCatalogModalities,
  resolveModelFromIndex,
  resolveVisionFromIndex,
} from '../src/app/services/modelVisionCatalog.ts';

// Current models.dev/models.json shape (2026): a flat object keyed by canonical
// model id, with modalities.input/output directly on each model record.
const currentSnapshot = {
  'alibaba/qwen3.8-27b': {
    id: 'alibaba/qwen3.8-27b',
    name: 'Qwen3.8 27B',
    description: 'Dense 27B vision-language model',
    attachment: true,
    reasoning: true,
    tool_call: true,
    structured_output: true,
    temperature: true,
    release_date: '2026-08-14',
    last_updated: '2026-08-14',
    modalities: { input: ['text', 'image', 'video'], output: ['text'] },
    open_weights: true,
    limit: { context: 262144, output: 32768 },
  },
  'zhipuai/glm-5.3-flash': {
    id: 'zhipuai/glm-5.3-flash',
    name: 'GLM-5.3-Flash',
    description: 'Multimodal model',
    attachment: true,
    reasoning: true,
    tool_call: true,
    temperature: true,
    release_date: '2026-08-01',
    last_updated: '2026-08-01',
    modalities: { input: ['text', 'image', 'video', 'pdf'], output: ['text'] },
    open_weights: false,
    limit: { context: 262144, output: 65536 },
  },
  'deepseek/deepseek-v4.1-flash': {
    id: 'deepseek/deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash',
    description: 'Vision-capable DeepSeek model',
    attachment: true,
    reasoning: true,
    tool_call: true,
    temperature: true,
    release_date: '2026-08-01',
    last_updated: '2026-08-01',
    modalities: { input: ['text', 'image'], output: ['text'] },
    open_weights: false,
    limit: { context: 262144, output: 65536 },
  },
  'acme/text-only': {
    id: 'acme/text-only',
    name: 'Text Only',
    description: 'Text-only fixture',
    attachment: false,
    reasoning: false,
    tool_call: true,
    temperature: true,
    release_date: '2026-01-01',
    last_updated: '2026-01-01',
    modalities: { input: ['text'], output: ['text'] },
    open_weights: true,
    limit: { context: 32768, output: 8192 },
  },
};

assert.equal(collectCatalogRecords(currentSnapshot).length, 4);
const currentIndex = buildModelVisionIndex(currentSnapshot);
assert.equal(currentIndex.modelCount, 4);
assert.equal(resolveVisionFromIndex(currentIndex, 'alibaba/qwen3.8-27b').vision, true);
assert.equal(resolveVisionFromIndex(currentIndex, 'acme/text-only').vision, false);
assert.deepEqual(getCatalogModalities(resolveModelFromIndex(currentIndex, 'alibaba/qwen3.8-27b')!), {
  input: ['text', 'image', 'video'],
  output: ['text'],
});

// Serving-provider namespaces can differ from models.dev's canonical author
// namespace. Match on a collision-safe leaf identity rather than hard-coding
// namespace rewrites.
assert.equal(resolveModelFromIndex(currentIndex, 'qwen/qwen3.8-27b')?.id, 'alibaba/qwen3.8-27b');
assert.equal(resolveModelFromIndex(currentIndex, 'z-ai/glm-5.3-flash')?.id, 'zhipuai/glm-5.3-flash');
assert.equal(resolveModelFromIndex(currentIndex, 'deepseek/deepseek-v4.1-flash')?.id, 'deepseek/deepseek-v4.1-flash');
assert.equal(resolveVisionFromIndex(currentIndex, 'qwen/qwen3.8-27b:free').vision, true);
assert.equal(resolveVisionFromIndex(currentIndex, 'z-ai/glm-5.3-flash:cloud').vision, true);

// Ollama-style size tags are identity, not deployment decoration. Slugging the
// complete leaf makes `vendor/model:27b` compatible with `author/model-27b`.
const taggedSnapshot = {
  'author/example-27b': {
    id: 'author/example-27b',
    name: 'Example 27B',
    modalities: { input: ['text', 'image'], output: ['text'] },
  },
};
const taggedIndex = buildModelVisionIndex(taggedSnapshot);
assert.equal(resolveModelFromIndex(taggedIndex, 'example:27b')?.id, 'author/example-27b');
assert.equal(resolveModelFromIndex(taggedIndex, 'example:27b-cloud')?.id, 'author/example-27b');

// Alias collisions fail closed rather than choosing the wrong model.
const collisionSnapshot = {
  'one/shared-model': {
    id: 'one/shared-model',
    name: 'Shared Model A',
    modalities: { input: ['text', 'image'], output: ['text'] },
  },
  'two/shared-model': {
    id: 'two/shared-model',
    name: 'Shared Model B',
    modalities: { input: ['text'], output: ['text'] },
  },
};
const collisionIndex = buildModelVisionIndex(collisionSnapshot);
assert.equal(resolveVisionFromIndex(collisionIndex, 'shared-model').vision, 'unknown');
assert.equal(resolveVisionFromIndex(collisionIndex, 'vendor/shared-model').vision, 'unknown');
assert.equal(resolveVisionFromIndex(collisionIndex, 'one/shared-model').vision, true);
assert.equal(resolveVisionFromIndex(collisionIndex, 'two/shared-model').vision, false);

// Preserve historical provider -> models snapshots and architecture fields so
// previously cached r13 data does not become unreadable after the patch.
const legacySnapshot = {
  acme: {
    models: {
      sighted: {
        id: 'acme/sighted',
        canonical_slug: 'acme/sighted-20260915',
        name: 'Acme: Sighted',
        architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
      },
      blind: {
        id: 'acme/blind',
        name: 'Acme: Blind',
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      },
    },
  },
};
assert.equal(collectCatalogRecords(legacySnapshot).length, 2);
const legacyIndex = buildModelVisionIndex(legacySnapshot);
assert.equal(resolveVisionFromIndex(legacyIndex, 'acme/sighted').vision, true);
assert.equal(resolveVisionFromIndex(legacyIndex, 'acme/blind').vision, false);
assert.equal(resolveVisionFromIndex(legacyIndex, 'acme/sighted-20260915').vision, true);

// Also preserve prior array/data-wrapper compatibility.
const wrappedSnapshot = { data: Object.values(currentSnapshot) };
assert.equal(collectCatalogRecords(wrappedSnapshot).length, 4);
assert.equal(buildModelVisionIndex(wrappedSnapshot).modelCount, 4);

// Optional exhaustive verification against a downloaded live models.json.
// Usage: MODELS_DEV_FIXTURE=/path/to/models-dev.json npm run test:model-vision
const liveFixture = process.env.MODELS_DEV_FIXTURE;
if (liveFixture) {
  const liveSnapshot = JSON.parse(fs.readFileSync(liveFixture, 'utf8')) as Record<string, unknown>;
  const records = collectCatalogRecords(liveSnapshot);
  const liveIndex = buildModelVisionIndex(liveSnapshot);
  assert.equal(records.length, Object.keys(liveSnapshot).length, 'every top-level models.json record must be collected');
  assert.equal(liveIndex.modelCount, Object.keys(liveSnapshot).length, 'every models.json record must be indexed');

  for (const [key, raw] of Object.entries(liveSnapshot)) {
    assert.ok(raw && typeof raw === 'object' && !Array.isArray(raw), `record ${key} must be an object`);
    const record = raw as any;
    const expectedId = typeof record.id === 'string' && record.id.trim() ? record.id : key;
    const resolved = resolveModelFromIndex(liveIndex, expectedId);
    assert.ok(resolved, `exact id ${expectedId} must resolve`);
    assert.equal(resolved!.id, expectedId);

    const expectedInput = Array.isArray(record.modalities?.input)
      ? record.modalities.input.map((item: unknown) => String(item).trim().toLowerCase()).filter(Boolean)
      : [];
    const expectedOutput = Array.isArray(record.modalities?.output)
      ? record.modalities.output.map((item: unknown) => String(item).trim().toLowerCase()).filter(Boolean)
      : [];
    assert.deepEqual(getCatalogModalities(resolved!), { input: expectedInput, output: expectedOutput }, `modalities for ${expectedId}`);

    if (expectedInput.length > 0) {
      assert.equal(resolveVisionFromIndex(liveIndex, expectedId).vision, expectedInput.includes('image'), `vision for ${expectedId}`);
    }
  }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = fs.readFileSync(path.join(root, 'src/app/services/modelVision.ts'), 'utf8');
const catalog = fs.readFileSync(path.join(root, 'src/app/services/modelVisionCatalog.ts'), 'utf8');
const selector = fs.readFileSync(path.join(root, 'src/app/components/ModelSelector.tsx'), 'utf8');
const tools = fs.readFileSync(path.join(root, 'src/app/services/vulcanTools.ts'), 'utf8');

assert.doesNotMatch(runtime, /import \{\s*import \{/);
assert.match(runtime, /https:\/\/models\.dev\/models\.json/);
assert.match(runtime, /generalWS\.send\('network\/http-json'/);
assert.doesNotMatch(runtime, /fetch\(CATALOG_URL/);
assert.match(runtime, /indexedDB\.open/);
assert.match(runtime, /Store the COMPLETE upstream snapshot/);
assert.match(runtime, /getModelCatalogRecord/);
assert.match(runtime, /getModelDisplayName/);
assert.match(runtime, /getModelModalities/);
assert.match(runtime, /getCatalogModalities/);
assert.match(runtime, /vulcan:model-catalog-updated/);
assert.match(catalog, /record\.modalities\?\.input/);
assert.match(catalog, /flatModelsJsonRecords/);
assert.match(selector, /getModelDisplayName\(model\.id\)/);
assert.match(selector, /getModelDisplayName\(selectedModel\)/);
assert.match(tools, /description: modelVision === true \? VIEW_FILE_VISION_DESCRIPTION : VIEW_FILE_TEXT_DESCRIPTION/);
assert.match(tools, /properties: modelVision === true[\s\S]*region/);
assert.match(tools, /if \(ctx\.modelVision !== true\)[\s\S]*image_view_unavailable/);

console.log(`Model catalog identity regression: ok${liveFixture ? ' (live models.json verified)' : ''}`);
