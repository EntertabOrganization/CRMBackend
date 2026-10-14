import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { badRequest, unauthorized } from '@/src/server/errors';
import { readJson } from '@/src/server/request';
import { fail, ok, route, runAutomationDue, runCalendarReminders, runCalendarAvailability, runUploadCleanup, runUploadProcessing, runFileObjectGarbage, runDocumentEditCleanup, runDocumentGeneration } from '@/src/server/response';
import { AutomationDiagnosticRetention } from '@/src/server/automation/diagnostic-retention';
import { prisma } from '@/src/server/prisma-client';

function assertJobToken(request: NextRequest) {
  const fixturePath = process.env.TEST_INTERNAL_JOB_TOKEN_FILE;
  let expected = process.env.INTERNAL_JOB_TOKEN ?? '';
  if (fixturePath) {
    try { expected = readFileSync(fixturePath, 'utf8').trim(); } catch { expected = ''; }
  }
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
  if (jobName === 'automation-diagnostic-retention') {
    try {
      assertJobToken(request);
      return ok(await new AutomationDiagnosticRetention(prisma).run(await readJson(request, 64 * 1024)));
    } catch (error) { return fail(error); }
  }
  if (jobName === 'automation-run' || jobName === 'calendar-reminders' || jobName === 'calendar-availability' || jobName === 'booking-notifications' || jobName === 'upload-cleanup' || jobName === 'upload-processing' || jobName === 'file-object-garbage' || jobName === 'document-edit-cleanup' || jobName === 'document-generation') {
    // Runs outside the request transaction wrapper. Reminder/automation claims use leases; availability pages
    // use optimistic version fencing. Each worker commits its own bounded steps without nesting the request queue.
    try {
      assertJobToken(request);
      const uploadJob = jobName === 'upload-cleanup' || jobName === 'upload-processing' || jobName === 'file-object-garbage' || jobName === 'document-edit-cleanup' || jobName === 'document-generation';
      const body = await readJson<Record<string, unknown>>(request, uploadJob ? 64 * 1024 : undefined);
      if (uploadJob && (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'limit')))
        throw badRequest('VALIDATION_ERROR', 'Supply an object containing only limit.');
      if (jobName === 'calendar-reminders' || jobName === 'calendar-availability' || jobName === 'booking-notifications' || uploadJob) {
        if (body.limit !== undefined && (typeof body.limit !== 'number' || !Number.isInteger(body.limit) || body.limit < 1 || body.limit > 100))
          throw badRequest('VALIDATION_ERROR', 'limit must be an integer between 1 and 100.');
        const limit = typeof body.limit === 'number' ? body.limit : 25;
        if (jobName === 'upload-cleanup') return ok(await runUploadCleanup(limit));
        if (jobName === 'document-edit-cleanup') return ok(await runDocumentEditCleanup(limit));
        if (jobName === 'document-generation') return ok(await runDocumentGeneration(limit));
        if (jobName === 'file-object-garbage') return ok(await runFileObjectGarbage(limit));
        if (jobName === 'upload-processing') return ok(await runUploadProcessing(limit));
        if (jobName === 'booking-notifications') return ok(await appContext.bookingNotifications.runDue(limit));
        return ok(await (jobName === 'calendar-availability' ? runCalendarAvailability(limit) : runCalendarReminders(limit)));
      }
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
      case 'commercial-run':
        return appContext.commercialPack.jobs.runDue(new Date(),typeof body.limit==='number'?Math.min(Math.max(body.limit,1),100):25);
      case 'task-recurrence-run':
        // Exactly-once per occurrence: duplicate deliveries find the CREATED instance and do nothing.
        return appContext.collab.tasks.templates.runDue(new Date(), typeof body.limit === 'number' ? Math.min(Math.max(body.limit, 1), 500) : 100);
      case 'task-overdue':
        return appContext.collab.tasks.tasks.runOverdueSweep();
      case 'commercial-maintenance':
        return {expiredEstimates:appContext.commercialPack.commerce.expireDueEstimates().length,breachedSla:appContext.commercialPack.contactCenter.checkSla().length};
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
