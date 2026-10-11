/** Shared worker orchestration: state units commit before/after provider I/O; stale leases are fenced by the domain. */
export interface LeaseStateRunner {
  unit<T>(fn: () => Promise<T> | T): Promise<T>;
  claimDue?(limit: number, token: string, now: Date): Promise<string[]>;
}
export type DeliveryOutcome =
  | { kind: 'SENT'; reference: string | null }
  | { kind: 'SUPPRESSED' }
  | { kind: 'FAILED'; code: string };
export interface LeaseJobHandler<Ticket> {
  claimDue(limit: number, token: string, now: Date): string[];
  prepare(id: string, token: string, now: Date): Ticket | null;
  deliver(ticket: Ticket, signal?: AbortSignal): Promise<DeliveryOutcome>;
  finish(ticket: Ticket, outcome: DeliveryOutcome, now: Date): boolean;
}
export class LeaseJobRunner<Ticket> {
  constructor(private readonly handler: LeaseJobHandler<Ticket>, private readonly state: LeaseStateRunner,
    private readonly options: { deliveryTimeoutMs?: number } = {}) {}
  private async deliver(ticket: Ticket): Promise<DeliveryOutcome> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([this.handler.deliver(ticket, controller.signal), new Promise<DeliveryOutcome>((resolve) => {
        timeout = setTimeout(() => { controller.abort(); resolve({ kind: 'FAILED', code: 'JOB_DELIVERY_TIMEOUT' }); }, this.options.deliveryTimeoutMs ?? 60_000);
      })]);
    } finally { if (timeout) clearTimeout(timeout); }
  }
  async runDue(options: { limit?: number; now?: Date; token?: string } = {}) {
    const token = options.token ?? crypto.randomUUID();
    const limit = options.limit ?? 25;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Job limit must be an integer between 1 and 100.');
    const result = { claimed: 0, sent: 0, failed: 0, suppressed: 0, skipped: 0 };
    // Claim small waves just before dispatch, so a large backlog cannot spend its leases waiting behind slow I/O.
    while (result.claimed < limit) {
      const batchLimit = Math.min(5, limit - result.claimed), claimAt = options.now ?? new Date();
      const ids = this.state.claimDue ? await this.state.claimDue(batchLimit, token, claimAt) : await this.state.unit(() => this.handler.claimDue(batchLimit, token, claimAt));
      if (!ids.length) break;
      result.claimed += ids.length;
      await Promise.all(ids.map(async (id) => {
        try {
          const ticket = await this.state.unit(() => this.handler.prepare(id, token, options.now ?? new Date()));
          if (!ticket) { result.skipped += 1; return; }
          // Delivery deliberately runs outside the serialized hydrate/mutate/persist unit.
          const outcome = await this.deliver(ticket);
          const committed = await this.state.unit(() => this.handler.finish(ticket, outcome, options.now ?? new Date()));
          if (!committed) result.skipped += 1;
          else if (outcome.kind === 'SENT') result.sent += 1;
          else if (outcome.kind === 'SUPPRESSED') result.suppressed += 1;
          else result.failed += 1;
        } catch {
          // Unexpected state/commit failure leaves the durable lease to expire. Other jobs still run.
          result.failed += 1;
        }
      }));
    }
    return result;
  }
}
