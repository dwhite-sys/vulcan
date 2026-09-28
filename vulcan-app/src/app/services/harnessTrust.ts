export type HarnessTrustState = 'first' | 'changed';

export interface HarnessTrustDetails {
  state: HarnessTrustState;
  endpoint: string;
  harnessName: string;
  identity: string;
  fingerprint: string;
  expectedFingerprint?: string;
  pinKey: string;
}

type TrustDecision = { action: 'trust' | 'replace'; remember: boolean } | { action: 'cancel' };
type TrustHandler = (details: HarnessTrustDetails) => Promise<TrustDecision>;

const PIN_PREFIX = 'vulcan.server-identity:';
let handler: TrustHandler | null = null;
const handlerWaiters = new Set<() => void>();
const pendingByEndpoint = new Map<string, Promise<void>>();
const sessionPins = new Map<string, string>();
const rejectedEndpoints = new Set<string>();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function normalizeHarnessEndpoint(url: string): string {
  const parsed = new URL(url);
  return parsed.host;
}

export function harnessPinKey(url: string): string {
  return `${PIN_PREFIX}${normalizeHarnessEndpoint(url)}`;
}

async function fingerprintFor(identity: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', identity));
  return `SHA256:${Array.from(digest, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':')}`;
}

async function fingerprintForStored(encoded: string): Promise<string> {
  return fingerprintFor(base64ToBytes(encoded));
}

export function setHarnessTrustHandler(next: TrustHandler | null): () => void {
  handler = next;
  if (next) {
    for (const resolve of handlerWaiters) resolve();
    handlerWaiters.clear();
  }
  return () => {
    if (handler === next) handler = null;
  };
}

async function waitForTrustHandler(): Promise<TrustHandler> {
  if (handler) return handler;
  await new Promise<void>((resolve) => handlerWaiters.add(resolve));
  if (!handler) throw new Error('Harness identity approval became unavailable.');
  return handler;
}

export async function requireTrustedHarness(url: string, identity: Uint8Array): Promise<void> {
  const endpoint = normalizeHarnessEndpoint(url);
  const existingPending = pendingByEndpoint.get(endpoint);
  if (existingPending) return existingPending;

  const request = (async () => {
    const pinKey = harnessPinKey(url);
    const encoded = bytesToBase64(identity);
    if (rejectedEndpoints.has(endpoint)) throw new Error('Harness identity approval was cancelled.');
    const pinned = localStorage.getItem(pinKey);
    if (pinned === encoded || sessionPins.get(endpoint) === encoded) return;

    const trustHandler = await waitForTrustHandler();

    const fingerprint = await fingerprintFor(identity);
    const details: HarnessTrustDetails = {
      state: pinned ? 'changed' : 'first',
      endpoint,
      harnessName: endpoint.split(':')[0] || 'Vulcan Harness',
      identity: 'Ed25519',
      fingerprint,
      expectedFingerprint: pinned ? await fingerprintForStored(pinned) : undefined,
      pinKey,
    };

    const decision = await trustHandler(details);
    if (decision.action === 'cancel') {
      rejectedEndpoints.add(endpoint);
      throw new Error('Harness identity was not trusted.');
    }
    if (details.state === 'changed' && decision.action !== 'replace') {
      throw new Error('Harness identity changed and replacement was not approved.');
    }
    if (decision.remember) {
      // Do not silently degrade a requested persistent trust decision to a
      // session-only pin. A failed write must leave the endpoint untrusted so
      // the next connection cannot bypass approval.
      localStorage.setItem(pinKey, encoded);
      if (localStorage.getItem(pinKey) !== encoded) {
        throw new Error('Vulcan could not persist the trusted harness identity on this device.');
      }
    }
    sessionPins.set(endpoint, encoded);
    rejectedEndpoints.delete(endpoint);
  })();

  pendingByEndpoint.set(endpoint, request);
  try {
    await request;
  } finally {
    pendingByEndpoint.delete(endpoint);
  }
}

export interface TrustedHarness {
  endpoint: string;
  pinKey: string;
  fingerprint: string;
}

export async function listTrustedHarnesses(): Promise<TrustedHarness[]> {
  const rows: TrustedHarness[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(PIN_PREFIX)) continue;
    const encoded = localStorage.getItem(key);
    if (!encoded) continue;
    try {
      rows.push({
        endpoint: key.slice(PIN_PREFIX.length),
        pinKey: key,
        fingerprint: await fingerprintForStored(encoded),
      });
    } catch { /* ignore corrupt legacy entries */ }
  }
  return rows.sort((a, b) => a.endpoint.localeCompare(b.endpoint));
}

export function forgetTrustedHarness(pinKey: string): void {
  const endpoint = pinKey.slice(PIN_PREFIX.length);
  localStorage.removeItem(pinKey);
  sessionPins.delete(endpoint);
  rejectedEndpoints.delete(endpoint);
}
