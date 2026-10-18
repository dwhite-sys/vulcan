import type { ReactNode } from 'react';

/** Keep the current composer mounted so cancellation preserves its draft. */
export function ChatLoadingBoundary({ title, onCancel, children }: {
  title: string | null; onCancel: () => void; children: ReactNode;
}) {
  const loading = title !== null;
  return (
    <div className="relative h-full">
      <div className="h-full" aria-hidden={loading || undefined} {...(loading ? { inert: '' } : {})}>
        {children}
      </div>
      {loading && (
        <div role="status" aria-live="polite" className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-ash-950 text-ash-300">
          <p>Opening {title}…</p>
          <p className="text-sm text-ash-500">Loading conversation history</p>
          <button type="button" className="rounded bg-ash-800 px-4 py-2 text-sm hover:bg-ash-700" onClick={onCancel}>Cancel</button>
        </div>
      )}
    </div>
  );
}
