import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { readJson } from '@/src/server/request';
import { route, runAutomationJob } from '@/src/server/response';
import { idempotencyKeyOf, requireWorkspaceContext } from '@/src/server/route-helpers';

type Params = { params: Promise<{ ruleId: string }> };

/**
 * Manual execution: the run is queued as an ordinary pinned job (same revision, conditions, logging and idempotency as an
 * automatic run) and then executed immediately, so the caller receives the outcome.
 */
export async function POST(request: NextRequest, { params }: Params) {
  let queuedJobId: string | null = null;
  const queued = await route(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request, 'bulk');
    const { ruleId } = await params;
    const body = await readJson<Record<string, unknown>>(request);
    const result = appContext.automation.execution.executeManually(user, workspaceId, ruleId, {
      ...body,
      idempotencyKey: body.idempotencyKey ?? idempotencyKeyOf(request),
    });
    queuedJobId = result.queued ? result.jobId : null;
    return result;
  });
  if (!queued.ok || !queuedJobId) return queued;
  const jobId: string = queuedJobId;
  await runAutomationJob(jobId);
  return route(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request);
    return appContext.automation.execution.resultForJob(user, workspaceId, jobId);
  });
}
