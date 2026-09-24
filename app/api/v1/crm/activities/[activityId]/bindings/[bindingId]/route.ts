import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { route } from '@/src/server/response';
import { requireWorkspaceContext } from '@/src/server/route-helpers';

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ activityId: string; bindingId: string }> }) {
  return route(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request);
    const { activityId, bindingId } = await params;
    return appContext.activities.removeBinding(user, workspaceId, activityId, bindingId);
  });
}
