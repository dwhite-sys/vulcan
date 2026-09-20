/**
 * connectionLifecycle.ts — proactive connection recovery hints
 *
 * PLATFORM TOPOLOGY (keep these three paths converging here):
 *
 *   Electron desktop
 *     main.cjs powerMonitor `resume`
 *       -> preload `onConnectionMayBeStale`
 *       -> verifyConnection()
 *
 *   Capacitor / Android
 *     native App plugin `appStateChange({ isActive: true })`
 *       -> verifyConnection()
 *
 *   Plain web app
 *     visibilitychange/pageshow/online OR a large timer discontinuity
 *       -> verifyConnection()
 *
 * These signals are deliberately *hints*, never correctness requirements. They
 * mean only "the connection may have gone stale while this client was asleep,
 * backgrounded, frozen, or offline."  All normal WS operations still pass
 * through GeneralWSClient.ensureConnected(), so missing a platform event cannot
 * break recovery.  Conversely, a spurious lifecycle event is harmless: the
 * check is idempotent and reconfirmation is a cheap encrypted round trip.
 */

import { generalWS } from './ws';

type Cleanup = () => void;

const HEARTBEAT_MS = 30_000;
const TIMER_GAP_MS = HEARTBEAT_MS * 2 + 5_000;

let installed = false;
let verification: Promise<void> | null = null;

export function verifyConnection(): Promise<void> {
  if (verification) return verification;
  verification = generalWS.ensureConnected({ reconfirm: true })
    .catch(() => {
      // Recovery is also retried by the normal request path. Lifecycle probes
      // must never turn a background network transition into a user-facing error.
    })
    .finally(() => { verification = null; });
  return verification;
}

export function installConnectionLifecycle(): Cleanup {
  if (installed) return () => {};
  installed = true;
  const cleanups: Cleanup[] = [];

  // ── Electron desktop ──────────────────────────────────────────────────────
  // powerMonitor is main-process-only; preload forwards only the semantic
  // "connection may be stale" event, keeping Electron details out of WS logic.
  const electronAPI = (window as any).electronAPI;
  if (typeof electronAPI?.onConnectionMayBeStale === 'function') {
    const dispose = electronAPI.onConnectionMayBeStale(() => { void verifyConnection(); });
    if (typeof dispose === 'function') cleanups.push(dispose);
  }

  // ── Capacitor / Android ───────────────────────────────────────────────────
  // Vulcan may be built as a plain web/Electron app without Capacitor present,
  // so probe the native bridge rather than making it a mandatory web dependency.
  const capacitor = (window as any).Capacitor;
  const appPlugin = capacitor?.Plugins?.App;
  if (capacitor?.isNativePlatform?.() && typeof appPlugin?.addListener === 'function') {
    let removed = false;
    const listener = appPlugin.addListener('appStateChange', (state: { isActive?: boolean }) => {
      if (state?.isActive) void verifyConnection();
    });
    cleanups.push(() => {
      if (removed) return;
      removed = true;
      void Promise.resolve(listener).then((handle: any) => handle?.remove?.()).catch(() => {});
    });
  }

  // ── Plain web fallback (also useful inside native renderers) ───────────────
  const onVisible = () => { if (document.visibilityState === 'visible') void verifyConnection(); };
  const onPageShow = () => { void verifyConnection(); };
  const onOnline = () => { void verifyConnection(); };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('pageshow', onPageShow);
  window.addEventListener('online', onOnline);
  cleanups.push(() => document.removeEventListener('visibilitychange', onVisible));
  cleanups.push(() => window.removeEventListener('pageshow', onPageShow));
  cleanups.push(() => window.removeEventListener('online', onOnline));

  // Heartbeats are both server-observable proof-of-life and a browser suspend
  // detector. Background/sleep may freeze timers; a large jump means "verify
  // now" rather than "the socket is definitely dead."
  let lastTick = Date.now();
  const heartbeat = window.setInterval(() => {
    const now = Date.now();
    const gap = now - lastTick;
    lastTick = now;
    if (gap >= TIMER_GAP_MS || document.visibilityState === 'visible') {
      void verifyConnection();
    }
  }, HEARTBEAT_MS);
  cleanups.push(() => window.clearInterval(heartbeat));

  // Establish proof-of-life immediately rather than waiting for the first tick.
  void verifyConnection();

  return () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    installed = false;
  };
}
