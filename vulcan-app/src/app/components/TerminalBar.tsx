/**
 * TerminalBar
 *
 * The terminal header bar + dropdown slot selector. Shows:
 *   >_ Terminal {N}    {Agent|You}    • Connected ∨
 *
 * Chevron opens a dropdown listing all open slots (agent first, then user)
 * with a + at the bottom to open a new user slot.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import type { RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Terminal, ChevronDown, Plus, Lock, User, X } from 'lucide-react';
import type { SlotKind, TerminalSlotMeta } from '../types/vulcan';

interface TerminalBarProps {
  slots: TerminalSlotMeta[];
  activeSlot: TerminalSlotMeta | null;
  onSelectSlot: (slot: TerminalSlotMeta) => void;
  onOpenUserSlot: () => void;
  onCloseSlot: (slot: TerminalSlotMeta) => void;
  canOpenUserSlot: boolean;   // false when user already has 3
  isRunning?: boolean;        // agent command running in active slot
  menuAnchorRef: RefObject<HTMLDivElement | null>; // resize handle; dropdown is its DOM child
}

const SLOT_LABEL: Record<SlotKind, string> = {
  agent: 'Agent',
  user:  'You',
};

const SLOT_COLORS: Record<SlotKind, string> = {
  agent: '#a78bfa',   // violet — distinct from green user slots
  user:  '#23d18b',   // green  — matches the existing Connected indicator
};

export function TerminalBar({
  slots,
  activeSlot,
  onSelectSlot,
  onOpenUserSlot,
  onCloseSlot,
  canOpenUserSlot,
  isRunning = false,
  menuAnchorRef,
}: TerminalBarProps) {
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        dropdownRef.current && !dropdownRef.current.contains(target) &&
        menuRef.current && !menuRef.current.contains(target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);




  const agentSlots = slots.filter((s) => s.kind === 'agent').sort((a, b) => a.slot - b.slot);
  const userSlots  = slots.filter((s) => s.kind === 'user').sort((a, b) => a.slot - b.slot);

  const activeKind  = activeSlot?.kind ?? 'user';
  const activeNum   = activeSlot?.slot ?? 1;
  const activeColor = SLOT_COLORS[activeKind];
  const activeLabel = SLOT_LABEL[activeKind];
  const activeStatus = activeSlot?.status ?? 'disconnected';

  const handleSelect = useCallback((slot: TerminalSlotMeta) => {
    onSelectSlot(slot);
    setOpen(false);
  }, [onSelectSlot]);

  const handleClose = useCallback((e: React.MouseEvent, slot: TerminalSlotMeta) => {
    e.stopPropagation();
    onCloseSlot(slot);
  }, [onCloseSlot]);

  return (
    <div className="relative" ref={dropdownRef}>
      {/* ── Header bar ── */}
      <div
        className="flex items-center gap-2 px-3 select-none flex-shrink-0 border-t border-ash-800"
        style={{ background: '#252526', height: 32 }}
      >
        <Terminal className="w-3.5 h-3.5 flex-shrink-0" style={{ color: '#cccccc' }} />

        {/* Terminal label */}
        <span className="text-xs flex-1 truncate" style={{ color: '#cccccc' }}>
          Terminal {activeNum}
        </span>

        {/* Kind label */}
        <span className="text-xs flex-shrink-0 font-medium" style={{ color: activeColor }}>
          {activeLabel}
        </span>

        {/* Status + chevron — clicking either opens dropdown */}
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 pl-2 hover:opacity-80 transition-opacity"
          title="Switch terminal"
        >
          {activeStatus === 'connected' && (
            <span className="flex items-center gap-1 text-xs flex-shrink-0" style={{ color: activeColor }}>
              <span
                className={`w-1.5 h-1.5 rounded-full ${isRunning ? 'animate-pulse' : ''}`}
                style={{ background: activeColor }}
              />
              {isRunning ? 'Running' : 'Connected'}
            </span>
          )}
          {activeStatus === 'disconnected' && (
            <span className="text-xs flex-shrink-0" style={{ color: '#666666' }}>
              Disconnected
            </span>
          )}
          {activeStatus === 'closed-inactivity' && (
            <span className="text-xs flex-shrink-0" style={{ color: '#666666' }}>
              Closed
            </span>
          )}
          <ChevronDown
            className="w-3.5 h-3.5 flex-shrink-0 transition-transform"
            style={{
              color: '#888',
              transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
            }}
          />
        </button>
      </div>

      {/* ── Dropdown ── */}
      {open && createPortal(
        <div
          ref={menuRef}
          className="border border-ash-700 rounded-t-md overflow-hidden shadow-lg"
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 'calc(100% + 1px)',
            zIndex: 1000,
            background: '#1e1e1e',
          }}
        >
          {/* Agent slots */}
          {agentSlots.length > 0 && (
            <>
              <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider" style={{ color: '#555', background: '#252526' }}>
                Agent
              </div>
              {agentSlots.map((s) => (
                <SlotRow
                  key={`agent-${s.slot}`}
                  slot={s}
                  isActive={activeSlot?.kind === s.kind && activeSlot?.slot === s.slot}
                  onSelect={handleSelect}
                  onClose={handleClose}
                />
              ))}
            </>
          )}

          {/* User slots */}
          {(userSlots.length > 0 || canOpenUserSlot) && (
            <>
              <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider" style={{ color: '#555', background: '#252526' }}>
                You
              </div>
              {userSlots.map((s) => (
                <SlotRow
                  key={`user-${s.slot}`}
                  slot={s}
                  isActive={activeSlot?.kind === s.kind && activeSlot?.slot === s.slot}
                  onSelect={handleSelect}
                  onClose={handleClose}
                />
              ))}
            </>
          )}

          {/* Add user terminal */}
          <button
            onClick={() => { onOpenUserSlot(); setOpen(false); }}
            disabled={!canOpenUserSlot}
            className="w-full flex items-center gap-2 px-3 py-2 text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed border-t border-ash-800/50"
            style={{
              color: canOpenUserSlot ? '#23d18b' : '#555',
              background: 'transparent',
            }}
            onMouseEnter={(e) => canOpenUserSlot && ((e.currentTarget as HTMLElement).style.background = '#2a2a2a')}
            onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = 'transparent')}
          >
            <Plus className="w-3.5 h-3.5" />
            New terminal
          </button>
        </div>,
        menuAnchorRef.current ?? document.body,
      )}
    </div>
  );
}


// ── Individual slot row in dropdown ──────────────────────────────────────────

interface SlotRowProps {
  slot: TerminalSlotMeta;
  isActive: boolean;
  onSelect: (slot: TerminalSlotMeta) => void;
  onClose: (e: React.MouseEvent, slot: TerminalSlotMeta) => void;
}

function SlotRow({ slot, isActive, onSelect, onClose }: SlotRowProps) {
  const color  = SLOT_COLORS[slot.kind];
  const Icon   = slot.kind === 'agent' ? Lock : User;
  const status = slot.status;

  return (
    <div
      onClick={() => onSelect(slot)}
      className="flex items-center gap-2 px-3 py-2 cursor-pointer group transition-colors"
      style={{
        background: isActive ? '#2a2a2a' : 'transparent',
        color: '#cccccc',
      }}
      onMouseEnter={(e) => !isActive && ((e.currentTarget as HTMLElement).style.background = '#252526')}
      onMouseLeave={(e) => !isActive && ((e.currentTarget as HTMLElement).style.background = 'transparent')}
    >
      <Icon className="w-3 h-3 flex-shrink-0" style={{ color }} />
      <span className="text-xs flex-1">Terminal {slot.slot}</span>
      <span className="text-[10px]" style={{
        color: status === 'connected' ? color : '#555',
      }}>
        {status === 'connected' ? '● Connected'
          : status === 'closed-inactivity' ? 'Closed (inactivity)'
          : 'Disconnected'}
      </span>
      {/* Close button — only show on hover */}
      <button
        onClick={(e) => onClose(e, slot)}
        className="ml-1 opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-ash-700"
        title="Close terminal"
      >
        <X className="w-3 h-3" style={{ color: '#888' }} />
      </button>
    </div>
  );
}
