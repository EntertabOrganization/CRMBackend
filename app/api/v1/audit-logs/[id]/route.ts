import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { requireUser, workspaceHeader } from '@/src/server/request';
import { route } from '@/src/server/response';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return route(async () => {
    const user = await requireUser(request, appContext.store);
    const workspaceId = workspaceHeader(request) ?? null;
    const isOwner = workspaceId
      ? appContext.workspaces.assertMembership(user.id, workspaceId).role.isOwnerRole
      : false;
    const { id } = await params;
    return appContext.audit.get(id, workspaceId, isOwner);
  });
}
