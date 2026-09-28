/**
 * Switching servers is a context transaction, not a reconnect. Preserve the old
 * server until its pending writes finish and restore it if target hydration fails.
 */
export interface ServerSwitchAdapter<Context> {
  previousUrl: string;
  targetUrl: string;
  probe: (url: string) => Promise<void>;
  flush: () => Promise<void>;
  detach: () => void;
  connect: (url: string) => void;
  hydrate: () => Promise<Context>;
  commit: (url: string, context: Context) => void;
}


export const SERVER_SWITCH_PROBE_TIMEOUT_MS = 4000;

export const REQUIRED_VULCAN_CAPABILITIES = [
  'etna.multi_server',
  'etna.client_relay',
  'provider.per_entry_pov',
  'provider.client_relay',
  'config.client_owned_network',
  'network.transient_http',
  'provider.client_streaming',
  'runs.cancel_immediate',
] as const;

export function assertCompatibleVulcanMeta(meta: any): void {
  const capabilities = new Set(Array.isArray(meta?.capabilities) ? meta.capabilities : []);
  const missing = REQUIRED_VULCAN_CAPABILITIES.filter((capability) => !capabilities.has(capability));
  if (missing.length > 0) {
    throw new Error(`Vulcan server is missing required capabilities: ${missing.join(', ')}`);
  }
}

/**
 * Bound only the reachability/auth-boundary preflight that happens before the
 * currently usable server is detached. A black-holed TCP route must not leave
 * the switch transaction waiting on the browser/OS network timeout.
 *
 * This deliberately does not wrap secure WebSocket authentication/hydration:
 * once the target has proved reachable, password/trust interaction is allowed
 * to take normal user time rather than inheriting this short network deadline.
 */
export async function withServerSwitchProbeDeadline<T>(
  url: string,
  probe: (signal: AbortSignal) => Promise<T>,
  timeoutMs = SERVER_SWITCH_PROBE_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await probe(controller.signal);
  } catch (error) {
    if (timedOut || controller.signal.aborted) {
      const seconds = (timeoutMs / 1000).toFixed(timeoutMs % 1000 === 0 ? 0 : 1);
      throw new Error(`Timed out checking ${url} after ${seconds} seconds.`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Password-free Vulcan servers intentionally accept loopback clients only. */
export function isLoopbackVulcanServerUrl(url: string): boolean {
  const hostname = new URL(url).hostname.toLowerCase();
  return hostname === 'localhost'
    || hostname === '[::1]'
    || hostname === '[0:0:0:0:0:0:0:1]'
    || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

export async function transitionVulcanServer<Context>(adapter: ServerSwitchAdapter<Context>): Promise<void> {
  if (adapter.previousUrl === adapter.targetUrl) return;

  await adapter.probe(adapter.targetUrl);
  await adapter.flush();
  adapter.detach();
  adapter.connect(adapter.targetUrl);

  try {
    const context = await adapter.hydrate();
    adapter.commit(adapter.targetUrl, context);
  } catch (switchError) {
    try {
      adapter.connect(adapter.previousUrl);
      const previousContext = await adapter.hydrate();
      adapter.commit(adapter.previousUrl, previousContext);
    } catch (restoreError) {
      throw new Error(
        `Could not connect to the selected server (${String(switchError)}); `
        + `restoring the previous server also failed (${String(restoreError)}).`,
        { cause: switchError },
      );
    }
    throw switchError;
  }
}
