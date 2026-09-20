export interface ToolRepeatState {
  count: number;
  lastTurn: number;
}

/**
 * Record one exact tool-call signature in a short local window.
 *
 * The repeat blocker exists to catch tight model loops (A -> A -> A), not to
 * impose a lifetime quota on a useful call. Two complete intervening provider
 * turns without this exact signature reset the streak.
 */
export function noteLocalToolRepeat(
  state: Map<string, ToolRepeatState>,
  signature: string,
  turnIndex: number,
  resetAfterMissedTurns = 2,
): number {
  const previous = state.get(signature);
  const resetGap = resetAfterMissedTurns + 1;
  const count = !previous || turnIndex - previous.lastTurn >= resetGap
    ? 1
    : previous.count + 1;
  state.set(signature, { count, lastTurn: turnIndex });
  return count;
}
