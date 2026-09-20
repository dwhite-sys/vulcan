/** Client-owned connection bookmarks. Server passwords never belong here. */
export interface VulcanServerProfile {
  id: string;
  name: string;
  url: string;
}

const PROFILE_KEY = 'vulcan:server_profiles';
const ENDPOINT_KEY = 'vulcan:endpoint';
const DEFAULT_ENDPOINT = 'http://localhost:8468';

export function normalizeVulcanServerUrl(value: string): string {
  const parsed = new URL(value.trim());
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('A Vulcan server must use an HTTP or HTTPS address.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Server passwords cannot be stored in connection profiles.');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('A Vulcan server address cannot contain a query or fragment.');
  }
  return parsed.toString().replace(/\/$/, '');
}

function currentEndpoint(): string {
  try {
    const saved = localStorage.getItem(ENDPOINT_KEY);
    return normalizeVulcanServerUrl(saved ? JSON.parse(saved) : DEFAULT_ENDPOINT);
  } catch {
    return DEFAULT_ENDPOINT;
  }
}

function migratedProfile(endpoint: string): VulcanServerProfile {
  const hostname = new URL(endpoint).hostname;
  return {
    id: 'vulcan-server-default',
    name: hostname === 'localhost' || hostname === '127.0.0.1' ? 'Local' : hostname,
    url: endpoint,
  };
}

export function saveVulcanServerProfiles(profiles: VulcanServerProfile[]): boolean {
  try {
    const clean = profiles.map(({ id, name, url }) => ({
      id,
      name: name.trim(),
      url: normalizeVulcanServerUrl(url),
    }));
    if (clean.some((profile) => !profile.id || !profile.name)) return false;
    if (new Set(clean.map((profile) => profile.id)).size !== clean.length) return false;
    localStorage.setItem(PROFILE_KEY, JSON.stringify(clean));
    return true;
  } catch {
    return false;
  }
}

export function loadVulcanServerProfiles(): VulcanServerProfile[] {
  const endpoint = currentEndpoint();
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (raw) {
      const stored = JSON.parse(raw);
      if (Array.isArray(stored)) {
        const profiles = stored.filter((profile): profile is VulcanServerProfile =>
          typeof profile?.id === 'string'
          && typeof profile?.name === 'string'
          && typeof profile?.url === 'string',
        ).map(({ id, name, url }) => ({ id, name: name.trim(), url: normalizeVulcanServerUrl(url) }));
        if (!profiles.some((profile) => profile.url === endpoint)) {
          const fallback = migratedProfile(endpoint);
          if (profiles.some((profile) => profile.id === fallback.id)) fallback.id = `vulcan-server-${Date.now()}`;
          profiles.unshift(fallback);
          saveVulcanServerProfiles(profiles);
        }
        return profiles;
      }
    }
  } catch {
    // An invalid legacy registry must never prevent the known-good endpoint from loading.
  }
  const migrated = [migratedProfile(endpoint)];
  saveVulcanServerProfiles(migrated);
  return migrated;
}

export function newVulcanServerProfileId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `vulcan-server-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
