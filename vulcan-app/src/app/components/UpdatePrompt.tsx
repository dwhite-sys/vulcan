import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';

type UpdateState = {
  available: boolean;
  currentVersion?: string;
  latestVersion?: string;
  tag?: string;
  assetName?: string;
};

type UpdateProgress = {
  phase?: 'starting' | 'download' | 'verified' | 'installing' | 'restarting' | 'error';
  percent?: number | null;
  received?: number;
  total?: number;
  message?: string;
};

function displayVersion(value?: string) {
  const raw = String(value || '').trim().replace(/^v/i, '');
  const match = raw.match(/^(\d+)\.(\d+)\.(\d+)(?:[-.]?(alpha|beta|rc)[.-]?(\d+))?$/i);
  if (!match) return value || 'Unknown';
  return match[4]
    ? `v${match[1]}.${match[2]}.${match[3]}${match[4].toLowerCase()}${match[5]}`
    : `v${match[1]}.${match[2]}.${match[3]}`;
}

function progressCopy(progress: UpdateProgress) {
  switch (progress.phase) {
    case 'download':
      return ['Downloading update…', 'Fetching the verified release from GitHub.'];
    case 'verified':
      return ['Verifying update…', 'The download passed SHA-256 verification.'];
    case 'installing':
      return ['Installing update…', 'Preparing Vulcan to restart into the new release.'];
    case 'restarting':
      return ['Restarting Vulcan…', 'The update is ready. Vulcan will reopen automatically.'];
    case 'error':
      return ['Update failed', progress.message || 'Vulcan could not apply the update.'];
    default:
      return ['Preparing update…', 'Getting the release ready.'];
  }
}

export function UpdatePrompt() {
  const [state, setState] = useState<UpdateState | null>(null);
  const [open, setOpen] = useState(false);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const deferredTagRef = useRef<string | null>(null);

  useEffect(() => {
    const api = (window as any).electronAPI?.updates;
    if (!api) return;

    let disposed = false;
    void api.getState?.().then((next: UpdateState) => {
      if (disposed || !next?.available) return;
      setState(next);
      if (deferredTagRef.current !== next.tag) setOpen(true);
    }).catch(() => {});

    const disposeState = api.onState?.((next: UpdateState) => {
      if (!next?.available) {
        setState(next);
        setOpen(false);
        return;
      }
      setState(next);
      if (deferredTagRef.current !== next.tag) setOpen(true);
    });

    const disposeOpen = api.onOpen?.((next: UpdateState) => {
      if (next?.available) setState(next);
      deferredTagRef.current = null;
      setProgress(null);
      setBusy(false);
      setOpen(true);
    });

    const disposeProgress = api.onProgress?.((next: UpdateProgress) => {
      setProgress(next);
      if (next?.phase === 'error') setBusy(false);
    });

    return () => {
      disposed = true;
      disposeState?.();
      disposeOpen?.();
      disposeProgress?.();
    };
  }, []);

  if (!open || !state?.available) return null;

  const later = () => {
    if (busy) return;
    deferredTagRef.current = state.tag || null;
    setOpen(false);
    setProgress(null);
  };

  const install = async () => {
    const api = (window as any).electronAPI?.updates;
    if (!api?.install || busy) return;
    setBusy(true);
    setProgress({ phase: 'starting', percent: 0 });
    try {
      await api.install();
    } catch (error: any) {
      setProgress({ phase: 'error', message: error?.message || 'Vulcan could not apply the update.' });
      setBusy(false);
    }
  };

  const [progressTitle, progressDetail] = progressCopy(progress || {});
  const percent = typeof progress?.percent === 'number'
    ? Math.max(0, Math.min(100, progress.percent))
    : 0;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/55 backdrop-blur-[1px] px-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="vulcan-update-title"
        className="w-full max-w-[470px] overflow-hidden rounded-[13px] border border-ash-700 bg-ash-850 shadow-2xl"
      >
        <div className="flex items-center gap-3 px-[22px] pb-4 pt-[22px]">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] border border-[#7a4838] bg-[#f05a3c] text-white">
            <RefreshCw className="h-[18px] w-[18px]" strokeWidth={2.2} />
          </div>
          <div className="min-w-0">
            <div id="vulcan-update-title" className="text-[17px] font-semibold leading-5 text-ash-100">
              {progress ? progressTitle : 'Update found'}
            </div>
            <div className="mt-1 text-[11px] leading-4 text-ash-500">
              {progress ? progressDetail : 'A newer Vulcan release is available.'}
            </div>
          </div>
        </div>

        <div className="border-t border-ash-800 px-[22px] py-[22px]">
          {!progress ? (
            <>
              <p className="m-0 text-[14px] text-ash-300">
                Would you like to update and restart now?
              </p>

              <div className="mt-[18px] grid grid-cols-2 overflow-hidden rounded-[11px] border border-ash-700 bg-ash-850">
                <div className="border-r border-ash-800 px-[14px] py-[12px]">
                  <div className="text-[12px] text-ash-500">Installed</div>
                  <div className="mt-1 font-mono text-[14px] text-ash-100">
                    {displayVersion(state.currentVersion)}
                  </div>
                </div>
                <div className="px-[14px] py-[12px]">
                  <div className="text-[12px] text-ash-500">Available</div>
                  <div className="mt-1 font-mono text-[14px] text-ash-100">
                    {displayVersion(state.latestVersion || state.tag)}
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div>
              <div className="flex items-center justify-between gap-3 text-[12px] text-ash-500">
                <span>{state.assetName || 'Vulcan update'}</span>
                <span>{progress.phase === 'error' ? 'Failed' : `${percent}%`}</span>
              </div>
              <div className="mt-3 h-[7px] overflow-hidden rounded-full border border-ash-700 bg-ash-950">
                <div
                  className={`h-full transition-[width] duration-200 ${progress.phase === 'error' ? 'bg-red-500' : 'bg-[#f05a3c]'}`}
                  style={{ width: `${progress.phase === 'error' ? 100 : percent}%` }}
                />
              </div>
            </div>
          )}

          <div className="mt-5 flex justify-end gap-[10px]">
            {progress?.phase === 'error' ? (
              <>
                <button
                  type="button"
                  onClick={later}
                  className="h-[42px] rounded-[10px] border border-ash-700 bg-ash-850 px-4 text-[14px] text-ash-300 hover:bg-ash-800"
                >
                  Later
                </button>
                <button
                  type="button"
                  onClick={() => { setProgress(null); void install(); }}
                  className="h-[42px] rounded-[10px] bg-[#ee5a3b] px-5 text-[14px] font-medium text-white hover:bg-[#f16849]"
                >
                  Try Again
                </button>
              </>
            ) : !progress ? (
              <>
                <button
                  type="button"
                  onClick={later}
                  className="h-[42px] rounded-[10px] border border-ash-700 bg-ash-850 px-4 text-[14px] text-ash-300 hover:bg-ash-800"
                >
                  Later
                </button>
                <button
                  type="button"
                  onClick={() => void install()}
                  className="h-[42px] rounded-[10px] bg-[#ee5a3b] px-5 text-[14px] font-medium text-white hover:bg-[#f16849]"
                >
                  Update and Restart
                </button>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
