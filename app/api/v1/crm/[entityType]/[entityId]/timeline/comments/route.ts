import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { readJson } from '@/src/server/request';
import { route } from '@/src/server/response';
import { idempotencyKeyOf, entityTypeFromParam as entityTypeOf, requireWorkspaceContext } from '@/src/server/route-helpers';
import { resourceTimelineRouter } from '@/src/server/activities/resource-timeline-routes';

export async function POST(request: NextRequest, { params }: { params: Promise<{ entityType: string; entityId: string }> }) {
  if ((await params).entityType==='WORKFLOW_EXECUTION') return resourceTimelineRouter.dispatch(request);
  return route(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request, 'comment');
    const { entityType, entityId } = await params;
    return appContext.timeline.createComment(user, workspaceId, entityTypeOf(entityType), entityId, await readJson<Record<string, unknown>>(request), idempotencyKeyOf(request));
  });
}
