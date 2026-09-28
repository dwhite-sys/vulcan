import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  distanceFromTranscriptBottom,
  TranscriptScrollController,
  type TranscriptScrollSnapshot,
  type TranscriptViewport,
} from '../src/app/services/transcriptScroll.ts';

class ManualFrames {
  private sequence = 0;
  private pending = new Map<number, FrameRequestCallback>();

  request = (callback: FrameRequestCallback): number => {
    const handle = ++this.sequence;
    this.pending.set(handle, callback);
    return handle;
  };

  cancel = (handle: number): void => {
    this.pending.delete(handle);
  };

  get count(): number {
    return this.pending.size;
  }

  flush(): void {
    const callbacks = [...this.pending.values()];
    this.pending.clear();
    for (const callback of callbacks) callback(0);
  }
}

const frames = new ManualFrames();
const smoothCalls: { top: number; behavior: ScrollBehavior }[] = [];
const transitions: boolean[] = [];
const snapshots: TranscriptScrollSnapshot[] = [];
const viewport: TranscriptViewport = {
  scrollTop: 400,
  clientHeight: 300,
  scrollHeight: 700,
  scrollTo(options) {
    smoothCalls.push(options);
    this.scrollTop = options.top;
  },
};

const controller = new TranscriptScrollController(viewport, {
  requestFrame: frames.request,
  cancelFrame: frames.cancel,
  onFollowingChange: (following) => transitions.push(following),
  onSnapshot: (snapshot) => snapshots.push(snapshot),
});

assert.equal(distanceFromTranscriptBottom(viewport), 0);
assert.equal(controller.isFollowing(), true, 'new transcripts follow live output');

viewport.scrollHeight = 810;
controller.handleLayoutChange();
controller.handleLayoutChange();
controller.handleLayoutChange();
assert.equal(frames.count, 1, 'streaming, tool expansion, and iframe resizing share one animation frame');
frames.flush();
assert.equal(viewport.scrollTop, 510, 'live transcript remains bottom-anchored');
assert.equal(smoothCalls.length, 0, 'streaming never repeatedly restarts smooth animations');

controller.handleWheel(-12);
assert.equal(controller.isFollowing(), false, 'upward wheel input releases follow immediately');
viewport.scrollTop = 498;
controller.handleScroll();
assert.equal(controller.isFollowing(), false,
  'a small deliberate upward scroll cannot immediately re-enable follow within the larger release threshold');
viewport.scrollTop = 220;
controller.handleScroll();
viewport.scrollHeight = 1400;
controller.handleLayoutChange();
assert.equal(frames.count, 0, 'expanded tools and streamed text cannot pull readers away from history');
assert.equal(viewport.scrollTop, 220, 'manual reading position is preserved while content grows');

controller.resume('smooth');
assert.equal(controller.isFollowing(), true, 'jump-to-latest explicitly resumes following');
frames.flush();
assert.deepEqual(smoothCalls.at(-1), { top: 1100, behavior: 'smooth' });

viewport.scrollHeight = 1550;
controller.handleLayoutChange();
assert.equal(frames.count, 1);
controller.setSelecting(true);
assert.equal(frames.count, 0, 'starting text selection cancels any pending automatic scroll');
assert.equal(controller.isFollowing(), false, 'quote selection releases follow mode');
controller.handleLayoutChange();
assert.equal(frames.count, 0, 'selection remains stable while text or tools stream');
controller.setSelecting(false);
assert.equal(controller.isFollowing(), false, 'ending selection does not silently retake control');

viewport.scrollTop = 1245;
controller.handleScroll();
assert.equal(controller.isFollowing(), true, 'manual return to the bottom resumes following');

controller.restore({ top: 175, following: false });
assert.equal(viewport.scrollTop, 175, 'chat switching restores the saved viewport position');
assert.equal(controller.isFollowing(), false, 'chat switching restores its independent reading mode');
assert.equal(frames.count, 0);

controller.restore({ top: 400, following: true });
assert.equal(frames.count, 1, 'a previously following chat rejoins the latest output');
frames.flush();
assert.equal(viewport.scrollTop, 1250);

viewport.scrollHeight = 2000;
controller.handleLayoutChange();
assert.equal(frames.count, 1);
controller.destroy();
assert.equal(frames.count, 0, 'chat teardown cancels pending work');
assert.ok(snapshots.some((snapshot) => snapshot.top === 175 && !snapshot.following));
assert.deepEqual(transitions, [false, true, false, true, false, true]);

const source = await readFile(new URL('../src/app/components/ChatInterface.tsx', import.meta.url), 'utf8');
assert.match(source, /new ResizeObserver\(\(\) => controller\.handleLayoutChange\(\)\)/,
  'reasoning/tool/visualization expansion is tracked independently of event-array updates');
assert.match(source, /observer\?\.observe\(messagesContentRef\.current\)/,
  'the content tree—not just its fixed-height viewport—is observed');
assert.match(source, /document\.addEventListener\('selectionchange', selectionChanged\)/,
  'quote selections suspend automatic following');
assert.match(source, /const key = transcriptViewId \?\? chatId \?\? '__new__'/,
  'scroll identity can distinguish alternate transcript projections within one chat');
assert.match(source, /\[chatId, transcriptViewId, events\.length === 0\]/,
  'switching branches rebuilds the scroll controller before layout-follow logic runs');
assert.match(source, /<TranscriptRenderer[\s\S]*key=\{transcriptViewId \?\? chatId \?\? '__new__'\}/,
  'switching transcript projections resets virtualization state instead of reusing the previous branch cache');
assert.match(source, /transcriptScrollPositions\.get\(key\)/,
  'scroll position is independently restored for each transcript view');
assert.match(source, /aria-label="Jump to latest message"/,
  'detached readers receive an explicit way back to live output');
assert.doesNotMatch(source, /scrollIntoView\(\{ behavior: 'smooth' \}\)/,
  'per-token smooth-scroll animation restarts were removed');

console.log('Transcript scroll regression checks passed.');
