export interface TranscriptViewport {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  scrollTo?: (options: { top: number; behavior: ScrollBehavior }) => void;
}

export interface TranscriptScrollSnapshot {
  top: number;
  following: boolean;
}

interface TranscriptScrollOptions {
  threshold?: number;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
  onFollowingChange?: (following: boolean) => void;
  onSnapshot?: (snapshot: TranscriptScrollSnapshot) => void;
}

export const TRANSCRIPT_FOLLOW_THRESHOLD = 72;
export const TRANSCRIPT_RESUME_THRESHOLD = 8;

export function distanceFromTranscriptBottom(viewport: TranscriptViewport): number {
  return Math.max(0, viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop);
}

/** Viewport-local policy: streaming follows only until the reader takes control. */
export class TranscriptScrollController {
  private viewport: TranscriptViewport;
  private readonly threshold: number;
  private readonly requestFrame: (callback: FrameRequestCallback) => number;
  private readonly cancelFrame: (handle: number) => void;
  private readonly onFollowingChange?: (following: boolean) => void;
  private readonly onSnapshot?: (snapshot: TranscriptScrollSnapshot) => void;
  private frame = 0;
  private pendingBehavior: ScrollBehavior = 'auto';
  private selecting = false;
  private following = true;

  constructor(viewport: TranscriptViewport, options: TranscriptScrollOptions = {}) {
    this.viewport = viewport;
    this.threshold = options.threshold ?? TRANSCRIPT_FOLLOW_THRESHOLD;
    this.requestFrame = options.requestFrame ?? ((callback) => requestAnimationFrame(callback));
    this.cancelFrame = options.cancelFrame ?? ((handle) => cancelAnimationFrame(handle));
    this.onFollowingChange = options.onFollowingChange;
    this.onSnapshot = options.onSnapshot;
  }

  isFollowing(): boolean {
    return this.following;
  }

  snapshot(): TranscriptScrollSnapshot {
    return { top: this.viewport.scrollTop, following: this.following };
  }

  private remember(): void {
    this.onSnapshot?.(this.snapshot());
  }

  private setFollowing(next: boolean): void {
    if (this.following !== next) {
      this.following = next;
      this.onFollowingChange?.(next);
    }
    this.remember();
  }

  release(): void {
    if (this.frame) {
      this.cancelFrame(this.frame);
      this.frame = 0;
    }
    this.pendingBehavior = 'auto';
    this.setFollowing(false);
  }

  setSelecting(selecting: boolean): void {
    this.selecting = selecting;
    if (selecting) this.release();
  }

  handleScroll(): void {
    // Hysteresis matters: one deliberate wheel tick away from the bottom must
    // not instantly re-enable the follow mode that the wheel just released.
    const threshold = this.following ? this.threshold : TRANSCRIPT_RESUME_THRESHOLD;
    const nearBottom = distanceFromTranscriptBottom(this.viewport) <= threshold;
    if (nearBottom && !this.selecting) {
      this.setFollowing(true);
      return;
    }
    // A newly grown transcript can briefly move its bottom before our already
    // queued follow frame executes. That is not a reader scrolling away.
    if (this.following && this.frame) return;
    this.setFollowing(false);
  }

  handleWheel(deltaY: number): void {
    if (deltaY < 0 && this.viewport.scrollHeight > this.viewport.clientHeight) {
      this.release();
    }
  }

  handleLayoutChange(): void {
    if (this.following && !this.selecting) this.schedule('auto');
  }

  resume(behavior: ScrollBehavior = 'smooth'): void {
    this.selecting = false;
    this.setFollowing(true);
    this.schedule(behavior);
  }

  restore(snapshot?: TranscriptScrollSnapshot): void {
    this.selecting = false;
    if (!snapshot) {
      this.setFollowing(true);
      this.schedule('auto');
      return;
    }
    this.viewport.scrollTop = snapshot.top;
    this.setFollowing(snapshot.following);
    if (snapshot.following) this.schedule('auto');
  }

  private schedule(behavior: ScrollBehavior): void {
    if (behavior === 'smooth') this.pendingBehavior = 'smooth';
    if (this.frame) return;
    this.frame = this.requestFrame(() => {
      this.frame = 0;
      const requestedBehavior = this.pendingBehavior;
      this.pendingBehavior = 'auto';
      if (!this.following || this.selecting) return;
      const top = Math.max(0, this.viewport.scrollHeight - this.viewport.clientHeight);
      if (requestedBehavior === 'smooth' && this.viewport.scrollTo) {
        this.viewport.scrollTo({ top, behavior: 'smooth' });
      } else {
        // Never restart a smooth animation for each streamed token.
        this.viewport.scrollTop = top;
      }
      this.remember();
    });
  }

  destroy(): void {
    if (this.frame) this.cancelFrame(this.frame);
    this.frame = 0;
    this.remember();
  }
}
