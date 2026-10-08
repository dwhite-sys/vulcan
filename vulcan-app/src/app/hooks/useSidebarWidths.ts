import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ImperativePanelGroupHandle } from 'react-resizable-panels';

const storageKey = 'vulcan.sidebar-widths.v1';
const defaults = { chat: 20, workspace: 20 };

function loadWidths() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    return {
      chat: Number.isFinite(saved?.chat) ? Math.min(30, Math.max(15, saved.chat)) : defaults.chat,
      workspace: Number.isFinite(saved?.workspace) ? Math.min(50, Math.max(20, saved.workspace)) : defaults.workspace,
    };
  } catch { return defaults; }
}

export function useSidebarWidths(chatOpen: boolean, workspaceOpen: boolean) {
  const groupRef = useRef<ImperativePanelGroupHandle>(null);
  const [widths, setWidths] = useState(loadWidths);
  const remembered = useRef(widths);
  const userResizing = useRef(false);
  const restoring = useRef(false);

  // Panel registration rebuilds the layout. Restore both independently remembered
  // widths after registration, without treating that rebuild as a user resize.
  useLayoutEffect(() => {
    const chat = chatOpen ? remembered.current.chat : 0;
    const workspace = workspaceOpen ? Math.min(remembered.current.workspace, 70 - chat) : 0;
    restoring.current = true;
    groupRef.current?.setLayout([
      ...(chatOpen ? [chat] : []),
      100 - chat - workspace,
      ...(workspaceOpen ? [workspace] : []),
    ]);
    restoring.current = false;
  }, [chatOpen, workspaceOpen]);

  const onLayout = useCallback((layout: number[]) => {
    if (!userResizing.current || restoring.current || layout.length !== 1 + Number(chatOpen) + Number(workspaceOpen)) return;
    const next = {
      chat: chatOpen ? layout[0] : remembered.current.chat,
      workspace: workspaceOpen ? layout[layout.length - 1] : remembered.current.workspace,
    };
    remembered.current = next;
    setWidths(next);
    try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Storage may be unavailable. */ }
  }, [chatOpen, workspaceOpen]);

  const onDragging = useCallback((dragging: boolean) => {
    if (!dragging && userResizing.current) {
      const layout = groupRef.current?.getLayout();
      if (layout) onLayout(layout);
    }
    userResizing.current = dragging;
  }, [onLayout]);
  const onKeyDownCapture = useCallback((event: KeyboardEvent) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'].includes(event.key)) return;
    userResizing.current = true;
    requestAnimationFrame(() => {
      const layout = groupRef.current?.getLayout();
      if (layout) onLayout(layout);
      userResizing.current = false;
    });
  }, [onLayout]);

  return { groupRef, widths, onLayout, onDragging, onKeyDownCapture };
}
