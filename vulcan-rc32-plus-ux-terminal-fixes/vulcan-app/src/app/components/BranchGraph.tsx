import { useMemo, useState } from 'react';
import { Pencil } from 'lucide-react';
import type { BranchRecord } from '../types/vulcan';

interface BranchGraphProps {
  branches: BranchRecord[];
  selectedBranchId: string;
  currentBranchId: string;
  onSelectBranch: (branchId: string) => void;
  onRenameBranch: (branchId: string, title: string) => void;
}

function branchTime(branch: BranchRecord): string {
  const date = new Date(branch.createdAt);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function BranchGraph({ branches, selectedBranchId, currentBranchId, onSelectBranch, onRenameBranch }: BranchGraphProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const layout = useMemo(() => {
    const byId = new Map(branches.map((branch) => [branch.id, branch]));
    const depth = new Map<string, number>();
    const getDepth = (id: string): number => {
      if (depth.has(id)) return depth.get(id)!;
      const branch = byId.get(id);
      if (!branch?.parentBranchId || !byId.has(branch.parentBranchId)) { depth.set(id, 0); return 0; }
      const value = getDepth(branch.parentBranchId) + 1;
      depth.set(id, value);
      return value;
    };
    const ordered = [...branches].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    return ordered.map((branch, row) => ({ branch, row, depth: getDepth(branch.id) }));
  }, [branches]);

  const beginRename = (branch: BranchRecord) => { setEditingId(branch.id); setDraft(branch.title); };
  const finishRename = (save: boolean) => {
    if (!editingId) return;
    const title = draft.trim();
    if (save && title) onRenameBranch(editingId, title);
    setEditingId(null);
  };

  return (
    <div className="h-full min-h-0 overflow-auto bg-ash-950 p-5">
      <div className="relative min-w-[520px] pb-16">
        {layout.map(({ branch, row, depth }) => {
          const left = 28 + depth * 82;
          const top = 22 + row * 92;
          const parent = branch.parentBranchId ? layout.find((item) => item.branch.id === branch.parentBranchId) : undefined;
          const selected = branch.id === selectedBranchId;
          const current = branch.id === currentBranchId;
          const selectedHistorical = selected && !current;
          return (
            <div key={branch.id}>
              {parent && (
                <svg className="pointer-events-none absolute left-0 top-0 h-full w-full overflow-visible" aria-hidden="true">
                  <path
                    d={`M ${28 + parent.depth * 82 + 176} ${22 + parent.row * 92 + 34} H ${left - 18} V ${top + 34} H ${left}`}
                    fill="none" stroke="rgb(63 63 63)" strokeWidth="1.2"
                  />
                </svg>
              )}
              <div className="absolute z-10" style={{ left, top, width: 176 }}>
                {branch.origin !== 'root' && (
                  <div className="mb-1 pl-1 text-[9px] font-semibold tracking-[0.12em] text-coral-400">{branch.origin.toUpperCase()}</div>
                )}
                <button
                  type="button"
                  onClick={() => onSelectBranch(branch.id)}
                  className={`group w-full rounded-lg border bg-ash-900 px-3 py-2.5 text-left shadow-sm transition-colors ${selectedHistorical ? 'border-coral-500/80 shadow-[0_0_0_1px_rgba(244,114,76,0.08),0_0_14px_rgba(244,114,76,0.05)]' : current ? 'border-coral-800/70 shadow-[0_0_12px_rgba(244,114,76,0.035)]' : 'border-ash-700 hover:border-ash-600 hover:bg-ash-800'}`}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    {editingId === branch.id ? (
                      <input
                        autoFocus value={draft} onChange={(event) => setDraft(event.target.value)}
                        onClick={(event) => event.stopPropagation()}
                        onBlur={() => finishRename(true)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') { event.preventDefault(); finishRename(true); }
                          if (event.key === 'Escape') { event.preventDefault(); finishRename(false); }
                        }}
                        className="min-w-0 flex-1 rounded border border-coral-800 bg-ash-950 px-1.5 py-0.5 text-[12px] font-medium text-ash-100 outline-none focus:border-coral-500"
                      />
                    ) : (
                      <div className="min-w-0 flex-1 truncate text-[12px] font-medium text-ash-100">{branch.title}</div>
                    )}
                    {editingId !== branch.id && (
                      <span
                        role="button" tabIndex={0} title="Rename branch" aria-label={`Rename ${branch.title}`}
                        onClick={(event) => { event.stopPropagation(); beginRename(branch); }}
                        onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); beginRename(branch); } }}
                        className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded text-ash-500 opacity-70 transition-all hover:bg-ash-700 hover:text-ash-200 hover:opacity-100 focus-visible:bg-ash-700 focus-visible:text-ash-200 focus-visible:outline-none"
                      ><Pencil className="h-3 w-3" /></span>
                    )}
                  </div>
                  <div className="mt-1 flex items-center gap-1.5 text-[9px] text-ash-500">
                    <span>{branch.origin.toUpperCase()}</span><span>·</span><span>{branchTime(branch)}</span>
                    {current && <span className="ml-auto font-medium tracking-wide text-green-400">CURRENT</span>}
                    {selectedHistorical && <span className="ml-auto font-medium tracking-wide text-coral-400">SELECTED</span>}
                  </div>
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
