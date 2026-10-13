import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { routeWithMeta } from '@/src/server/response';
import { entityTypeFromParam as entityTypeOf, requireWorkspaceContext } from '@/src/server/route-helpers';
import { resourceTimelineRouter } from '@/src/server/activities/resource-timeline-routes';

export async function GET(request: NextRequest, { params }: { params: Promise<{ entityType: string; entityId: string }> }) {
  if ((await params).entityType==='WORKFLOW_EXECUTION') return resourceTimelineRouter.dispatch(request);
  return routeWithMeta(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request);
    const { entityType, entityId } = await params;
    return appContext.timeline.getTimeline(user, workspaceId, entityTypeOf(entityType), entityId, request.nextUrl.searchParams);
  });
}
