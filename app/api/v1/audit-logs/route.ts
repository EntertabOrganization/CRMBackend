import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { requireUser, workspaceHeader } from '@/src/server/request';
import { route } from '@/src/server/response';

export async function GET(request: NextRequest) {
  return route(async () => {
    const user = await requireUser(request, appContext.store);
    const workspaceId = workspaceHeader(request) ?? null;
    const isOwner = workspaceId
      ? appContext.workspaces.assertMembership(user.id, workspaceId).role.isOwnerRole
      : false;
    return appContext.audit.list(workspaceId, isOwner);
  });
}
