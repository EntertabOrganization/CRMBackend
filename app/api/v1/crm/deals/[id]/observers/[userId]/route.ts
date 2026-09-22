import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { badRequest } from '@/src/server/errors';
import { requireUser, workspaceHeader } from '@/src/server/request';
import { route } from '@/src/server/response';

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string; userId: string }> }) {
  return route(async () => {
    const user = await requireUser(request, appContext.store);
    const workspaceId = workspaceHeader(request);
    if (!workspaceId) throw badRequest('WORKSPACE_REQUIRED', 'X-Workspace-Id is required.');
    const { id, userId } = await params;
    return appContext.crmCore.removeObserver(user, workspaceId, 'DEAL', id, userId);
  });
}
