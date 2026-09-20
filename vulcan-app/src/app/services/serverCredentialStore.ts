type ElectronPasswordBridge = {
  status: () => Promise<{ available: boolean }>;
  get: (endpoint: string) => Promise<{ password: string | null }>;
  set: (endpoint: string, password: string) => Promise<unknown>;
  remove: (endpoint: string) => Promise<unknown>;
};

type CapacitorSecureStoragePlugin = {
  get: (options: { key: string }) => Promise<{ value?: string | null }>;
  set: (options: { key: string; value: string }) => Promise<unknown>;
  remove: (options: { key: string }) => Promise<unknown>;
};

export type ServerCredentialStore = {
  isAvailable: () => Promise<boolean>;
  get: (endpoint: string) => Promise<string | null>;
  set: (endpoint: string, password: string) => Promise<void>;
  remove: (endpoint: string) => Promise<void>;
};

export function normalizeCredentialEndpoint(endpoint: string): string {
  const parsed = new URL(endpoint.trim());
  if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
  if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Server passwords require an HTTP or HTTPS endpoint');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw new Error('Server password endpoints cannot contain credentials, paths, queries, or fragments');
  }
  return parsed.origin;
}

function capacitorCredentialKey(endpoint: string): string {
  return `vulcan.server-password.${encodeURIComponent(normalizeCredentialEndpoint(endpoint))}`;
}

function createElectronCredentialStore(bridge: ElectronPasswordBridge): ServerCredentialStore {
  return {
    isAvailable: async () => Boolean((await bridge.status())?.available),
    get: async (endpoint) => {
      const password = (await bridge.get(normalizeCredentialEndpoint(endpoint)))?.password;
      return typeof password === 'string' && password ? password : null;
    },
    set: async (endpoint, password) => {
      await bridge.set(normalizeCredentialEndpoint(endpoint), password);
    },
    remove: async (endpoint) => {
      await bridge.remove(normalizeCredentialEndpoint(endpoint));
    },
  };
}

function createCapacitorCredentialStore(plugin: CapacitorSecureStoragePlugin): ServerCredentialStore {
  return {
    isAvailable: async () => true,
    get: async (endpoint) => {
      try {
        const value = (await plugin.get({ key: capacitorCredentialKey(endpoint) }))?.value;
        return typeof value === 'string' && value ? value : null;
      } catch {
        // Native plugins commonly reject instead of returning null for a missing key.
        return null;
      }
    },
    set: async (endpoint, password) => {
      await plugin.set({ key: capacitorCredentialKey(endpoint), value: password });
    },
    remove: async (endpoint) => {
      try {
        await plugin.remove({ key: capacitorCredentialKey(endpoint) });
      } catch {
        // Removing an already-missing native credential is idempotent.
      }
    },
  };
}

export function getServerCredentialStore(runtime: any = globalThis): ServerCredentialStore | null {
  const electron = runtime?.electronAPI?.serverPasswords;
  if (electron
      && typeof electron.status === 'function'
      && typeof electron.get === 'function'
      && typeof electron.set === 'function'
      && typeof electron.remove === 'function') {
    return createElectronCredentialStore(electron);
  }

  const capacitor = runtime?.Capacitor;
  if (capacitor?.getPlatform?.() !== 'android' || capacitor?.isNativePlatform?.() !== true) return null;

  // Both widely used Capacitor secure-storage bridge names share this native
  // get/set/remove contract. Never select Capacitor Preferences or a web shim:
  // Android must provide a plugin backed by the platform Keystore.
  const plugin = capacitor.Plugins?.SecureStoragePlugin ?? capacitor.Plugins?.SecureStorage;
  if (!plugin
      || typeof plugin.get !== 'function'
      || typeof plugin.set !== 'function'
      || typeof plugin.remove !== 'function') return null;
  return createCapacitorCredentialStore(plugin);
}
