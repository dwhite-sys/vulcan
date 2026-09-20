/** Client-owned Provider/Etna configuration is scoped to the selected Vulcan server. */
const ENDPOINT_KEY = 'vulcan:endpoint';
const DEFAULT_ENDPOINT = 'http://localhost:8468';

export function activeVulcanProfileScope(): string {
  let value = DEFAULT_ENDPOINT;
  try {
    const raw = localStorage.getItem(ENDPOINT_KEY);
    if (raw) value = JSON.parse(raw);
  } catch { /* use default */ }
  try {
    const url = new URL(String(value));
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return DEFAULT_ENDPOINT;
  }
}

export function scopedNetworkKey(baseKey: string): string {
  return `${baseKey}:${encodeURIComponent(activeVulcanProfileScope())}`;
}

/**
 * One-time migration from the pre-RC global key. The legacy value belongs to
 * whichever Vulcan server was selected when this client upgraded.
 */
export function migrateScopedNetworkValue(baseKey: string): string | null {
  const key = scopedNetworkKey(baseKey);
  const scoped = localStorage.getItem(key);
  if (scoped !== null) return scoped;
  const legacy = localStorage.getItem(baseKey);
  if (legacy !== null) {
    localStorage.setItem(key, legacy);
    localStorage.removeItem(baseKey);
    return legacy;
  }
  return null;
}
