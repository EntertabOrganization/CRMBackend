import { timingSafeEqual } from 'node:crypto';
import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { badRequest, unauthorized } from '@/src/server/errors';
import { readJson } from '@/src/server/request';
import { fail, ok, route, runAutomationDue } from '@/src/server/response';

function assertJobToken(request: NextRequest) {
  const expected = process.env.INTERNAL_JOB_TOKEN ?? '';
  const provided = request.headers.get('x-internal-job-token') ?? '';
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  // Disabled unless a token is configured; compared in constant time.
  if (!expected || a.length !== b.length || !timingSafeEqual(a, b)) throw unauthorized();
}

/**
 * Operational endpoints for the scheduler / worker (not user-facing): overdue sweep, due reminders, Timeline
 * projection and Timeline rebuild. Every job is idempotent, so a retried or duplicated run is harmless.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ job: string }> }) {
  const jobName = (await params).job;
  if (jobName === 'automation-run') {
    // Runs OUTSIDE the request transaction wrapper: it claims jobs atomically (lease + SKIP LOCKED) and every step
    // (including slow external calls) manages its own transactions, so it must not hold the request queue.
    try {
      assertJobToken(request);
      const body = await readJson<Record<string, unknown>>(request);
      return ok(await runAutomationDue(typeof body.limit === 'number' ? Math.min(Math.max(body.limit, 1), 100) : 25));
    } catch (error) {
      return fail(error);
    }
  }
  return route(async () => {
    assertJobToken(request);
    const { job } = await params;
    const body = await readJson<Record<string, unknown>>(request);
    switch (job) {
      case 'overdue':
        return appContext.activities.runOverdueSweep();
      case 'reminders':
        return appContext.activities.runDueReminders();
      case 'automation-ingest':
        // Matches unseen outbox events against active Rules and records jobs (also done inline after every request).
        return appContext.automation.ingestPending();
      case 'timeline-project':
        return appContext.timeline.projectPending(typeof body.workspaceId === 'string' ? body.workspaceId : undefined);
      case 'timeline-rebuild': {
        if (typeof body.workspaceId !== 'string') throw badRequest('WORKSPACE_REQUIRED', 'workspaceId is required.');
        const date = (value: unknown) => (typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(value) : undefined);
        return appContext.timeline.rebuild(body.workspaceId, {
          entityType: typeof body.entityType === 'string' ? body.entityType : undefined,
          entityId: typeof body.entityId === 'string' ? body.entityId : undefined,
          from: date(body.from),
          to: date(body.to),
        });
      }
      default:
        throw badRequest('JOB_UNKNOWN', 'Unknown job.');
    }
  });
}