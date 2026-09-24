import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { routeWithMeta } from '@/src/server/response';
import { entityTypeFromParam as entityTypeOf, requireWorkspaceContext } from '@/src/server/route-helpers';

export async function GET(request: NextRequest, { params }: { params: Promise<{ entityType: string; entityId: string }> }) {
  return routeWithMeta(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request);
    const { entityType, entityId } = await params;
    return appContext.timeline.getTimeline(user, workspaceId, entityTypeOf(entityType), entityId, request.nextUrl.searchParams);
  });
}
