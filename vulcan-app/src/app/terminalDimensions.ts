/* Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License; see vulcan/terminal_host/vendor/LICENSE.vscode.
 * Adapted from VS Code 7b3839f429b5bd42e1b2657aa26f037cfa1a0c12:
 * terminalInstance._evaluateColsAndRows/_getDimension and
 * xtermTerminal.getXtermScaledDimensions. Use the pinned xterm renderer's actual
 * device cell dimensions instead of independently estimating font metrics.
 */
import type { Terminal } from '@xterm/xterm';

export function measureTerminal(terminal: Terminal): { cols: number; rows: number } | undefined {
  const element = terminal.element;
  const parent = element?.parentElement;
  if (!element || !parent || parent.clientWidth === 0 || parent.clientHeight === 0) return;
  // xterm's own FitAddon uses this same version-dependent renderer interface.
  const core = (terminal as any)._core;
  const cell = core?._renderService?.dimensions?.device?.cell;
  if (!cell?.width || !cell?.height) return;
  const style = getComputedStyle(element);
  const padding = (name: string) => parseFloat(style.getPropertyValue(name)) || 0;
  const scrollbar = terminal.options.scrollback === 0 ? 0 : terminal.options.overviewRuler?.width || 15;
  const width = parent.clientWidth - padding('padding-left') - padding('padding-right') - scrollbar;
  const height = parent.clientHeight - padding('padding-top') - padding('padding-bottom');
  if (width <= 0 || height <= 0) return;
  const ratio = window.devicePixelRatio;
  return { cols: Math.max(2, Math.floor(width * ratio / cell.width)), rows: Math.max(1, Math.floor(height * ratio / cell.height)) };
}
