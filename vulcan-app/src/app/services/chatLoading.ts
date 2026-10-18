/** Navigation work is bounded independently of the WebSocket's RPC queue. */
export class SupersededChatLoadError extends Error {
  constructor() { super('Chat load superseded'); }
}

interface Load<T> {
  id: string;
  run: () => Promise<T>;
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export class ChatLoadCoordinator<T> {
  private loads = new Map<string, Load<T>>();
  private active: Load<T> | null = null;
  private queued: Load<T> | null = null;

  request(id: string, run: () => Promise<T>): Promise<T> {
    const existing = this.loads.get(id);
    if (existing) {
      if (existing === this.active) this.cancelQueued();
      return existing.promise;
    }
    let resolve!: Load<T>['resolve'];
    let reject!: Load<T>['reject'];
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    const load = { id, run, promise, resolve, reject };
    this.loads.set(id, load);
    if (!this.active) this.start(load);
    else {
      this.cancelQueued();
      this.queued = load;
    }
    return promise;
  }

  /** A server switch/disconnect must not reuse work from the old connection. */
  reset(): void {
    for (const load of this.loads.values()) load.reject(new SupersededChatLoadError());
    this.loads.clear();
    this.active = this.queued = null;
  }

  cancelQueued(): void {
    if (!this.queued) return;
    this.loads.delete(this.queued.id);
    this.queued.reject(new SupersededChatLoadError());
    this.queued = null;
  }

  private start(load: Load<T>): void {
    this.active = load;
    void (async () => {
      try { load.resolve(await load.run()); }
      catch (error) { load.reject(error); }
      finally {
        if (this.loads.get(load.id) === load) this.loads.delete(load.id);
        if (this.active === load) {
          this.active = null;
          const next = this.queued;
          this.queued = null;
          if (next) this.start(next);
        }
      }
    })();
  }
}

/** Preserve hydrated histories only while the server summary still agrees. */
export function reconcileChatSummaries<T extends {
  id: string; updatedAt: Date; events: unknown; branching?: unknown; _summaryOnly?: boolean;
}>(summaries: T[], cached: T[]): T[] {
  const byId = new Map(cached.map((chat) => [chat.id, chat]));
  return summaries.map((summary) => {
    const previous = byId.get(summary.id);
    return previous && !previous._summaryOnly
      && previous.updatedAt.getTime() === summary.updatedAt.getTime()
      ? { ...previous, ...summary, events: previous.events, branching: previous.branching, _summaryOnly: false }
      : summary;
  });
}
