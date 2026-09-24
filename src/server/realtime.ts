export type RealtimeHint = {
  type: string;
  workspaceId: string;
  /** Small invalidation payload: ids and versions only, never business content. */
  data: Record<string, unknown>;
  /** When set, only these users receive the hint (e.g. the responsible user of an Activity). */
  audienceUserIds?: string[];
};

type Subscriber = {
  id: string;
  workspaceId: string;
  userId: string;
  send: (hint: RealtimeHint) => void;
};

/**
 * Advisory realtime delivery. Hints are queued while a request runs and only released after its database transaction
 * commits, so a client can never learn about a change that was rolled back. REST remains the source of truth; a
 * missed hint is fully recovered by an ordinary reload.
 */
export class RealtimeHub {
  private queue: RealtimeHint[] = [];
  private readonly subscribers = new Map<string, Subscriber>();

  enqueue(hint: RealtimeHint) {
    this.queue.push(hint);
  }

  /** Called by the request wrapper after a successful commit. */
  flush() {
    const hints = this.queue;
    this.queue = [];
    for (const hint of hints) this.deliver(hint);
  }

  /** Called when the request failed; nothing was committed so nothing may be announced. */
  discard() {
    this.queue = [];
  }

  pendingCount() {
    return this.queue.length;
  }

  subscribe(subscriber: Omit<Subscriber, 'id'>) {
    const id = crypto.randomUUID();
    this.subscribers.set(id, { ...subscriber, id });
    return () => {
      this.subscribers.delete(id);
    };
  }

  subscriberCount() {
    return this.subscribers.size;
  }

  private deliver(hint: RealtimeHint) {
    for (const subscriber of this.subscribers.values()) {
      if (subscriber.workspaceId !== hint.workspaceId) continue;
      if (hint.audienceUserIds && !hint.audienceUserIds.includes(subscriber.userId)) continue;
      try {
        subscriber.send(hint);
      } catch {
        this.subscribers.delete(subscriber.id);
      }
    }
  }
}
