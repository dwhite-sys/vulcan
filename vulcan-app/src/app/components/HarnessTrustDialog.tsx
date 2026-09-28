import { useEffect, useState } from 'react';
import { X, ShieldCheck, Copy } from 'lucide-react';
import { setHarnessTrustHandler, type HarnessTrustDetails } from '../services/harnessTrust';

type Resolver = (decision: { action: 'trust' | 'replace'; remember: boolean } | { action: 'cancel' }) => void;

export function HarnessTrustDialog() {
  const [details, setDetails] = useState<HarnessTrustDetails | null>(null);
  const [resolver, setResolver] = useState<Resolver | null>(null);
  const [remember, setRemember] = useState(true);
  const [copied, setCopied] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);

  useEffect(() => setHarnessTrustHandler((next) => new Promise((resolve) => {
    setRemember(true);
    setCopied(false);
    setConfirmReplace(false);
    setDetails(next);
    setResolver(() => resolve);
  })), []);

  if (!details || !resolver) return null;

  const finish = (decision: Parameters<Resolver>[0]) => {
    resolver(decision);
    setDetails(null);
    setResolver(null);
  };

  const changed = details.state === 'changed';
  const copyFingerprint = async () => {
    await navigator.clipboard.writeText(details.fingerprint);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-6">
      <div className="w-full max-w-[610px] overflow-hidden rounded-[14px] border border-ash-700 bg-ash-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-ash-800 px-[22px] py-4">
          <div className="flex items-center gap-3">
            <div className={`flex h-8 w-8 items-center justify-center rounded-md ${changed ? 'bg-red-500' : 'bg-coral-500'}`}>
              <ShieldCheck className="h-5 w-5 text-white" />
            </div>
            <h2 className="text-lg font-semibold text-ash-100">
              {changed ? 'Harness Identity Changed' : 'First Connection to This Harness'}
            </h2>
          </div>
          <button onClick={() => finish({ action: 'cancel' })} className="rounded p-1 text-ash-500 transition-colors hover:bg-ash-800 hover:text-ash-300" aria-label="Cancel connection">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-[22px] py-5">
          <p className="mb-[18px] text-sm leading-6 text-ash-300">
            {changed
              ? 'The identity presented by this harness does not match the identity previously trusted for this endpoint.'
              : 'You are connecting to this harness for the first time. Verify its identity before trusting and continuing.'}
          </p>

          <div className="overflow-hidden rounded-[10px] border border-ash-700 bg-ash-950/35 text-sm">
            <IdentityRow label="Harness"><span className="text-ash-100">{details.harnessName}</span></IdentityRow>
            <IdentityRow label="Endpoint"><span className="select-text font-mono text-ash-100">{details.endpoint}</span></IdentityRow>
            <IdentityRow label="Identity"><span className="text-ash-100">{details.identity}</span></IdentityRow>
            {changed && details.expectedFingerprint && (
              <IdentityRow label="Expected">
                <span className="select-text break-all font-mono text-xs leading-5 text-ash-400">{details.expectedFingerprint}</span>
              </IdentityRow>
            )}
            <IdentityRow label={changed ? 'Received' : 'Fingerprint'} last>
              <div className="flex min-w-0 items-start gap-2">
                <span className={`min-w-0 flex-1 select-text break-all font-mono text-xs leading-5 ${changed ? 'text-red-400' : 'text-blue-400'}`}>{details.fingerprint}</span>
                <button onClick={copyFingerprint} className="shrink-0 rounded p-1 text-ash-500 hover:bg-ash-800 hover:text-ash-300" title="Copy fingerprint">
                  <Copy className="h-4 w-4" />
                </button>
              </div>
            </IdentityRow>
          </div>

          <div className={`mt-4 rounded-[9px] border px-3.5 py-3 text-[13px] leading-5 ${changed ? 'border-red-500/50 bg-red-500/10 text-red-200' : 'border-blue-400/40 bg-blue-400/10 text-blue-100'}`}>
            {changed
              ? 'Do not continue unless you expected the harness to be reinstalled or its identity to be reset. Your password has not been requested or sent.'
              : 'Vulcan will remember this identity on this device. If it changes later, the connection will stop before your password is requested.'}
          </div>
          {copied && <div className="mt-2 text-right text-xs text-green-400">Fingerprint copied</div>}

          {changed && confirmReplace && (
            <div className="mt-4 rounded-md border border-yellow-500/40 bg-yellow-500/10 p-3 text-sm text-yellow-100">
              This replaces the trusted identity for <span className="font-mono">{details.endpoint}</span>. Only continue if this change is expected.
            </div>
          )}

          <div className="mt-5 flex justify-end gap-2.5">
            <button onClick={() => finish({ action: 'cancel' })} className="rounded-lg border border-ash-700 bg-ash-900 px-4 py-2.5 text-sm text-ash-200 transition-colors hover:bg-ash-800">
              Cancel
            </button>
            {changed ? (
              confirmReplace ? (
                <button onClick={() => finish({ action: 'replace', remember: true })} className="rounded-lg border border-red-500 bg-red-500 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-red-600">
                  Trust New Identity
                </button>
              ) : (
                <button onClick={() => setConfirmReplace(true)} className="rounded-lg border border-red-500 bg-red-500 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-red-600">
                  Forget Old Identity…
                </button>
              )
            ) : (
              <button onClick={() => finish({ action: 'trust', remember })} className="rounded-lg border border-coral-500 bg-coral-500 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-coral-600">
                Trust This Harness
              </button>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-ash-800 px-[22px] py-3.5 text-xs text-ash-500">
          {!changed ? (
            <label className="flex items-center gap-2.5">
              <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} className="accent-coral-500" />
              Remember this identity on this device
            </label>
          ) : <span />}
          <span>{changed ? 'Connection blocked before authentication' : 'Server identity verified'}</span>
        </div>
      </div>
    </div>
  );
}

function IdentityRow({ label, children, last = false }: { label: string; children: React.ReactNode; last?: boolean }) {
  return (
    <div className={`grid grid-cols-[145px_minmax(0,1fr)] gap-[18px] px-3.5 py-3 ${last ? '' : 'border-b border-ash-800'}`}>
      <div className="text-ash-500">{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
