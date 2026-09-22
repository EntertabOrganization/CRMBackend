import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { readJson, requireUser, workspaceHeader } from '@/src/server/request';
import { badRequest } from '@/src/server/errors';
import { route } from '@/src/server/response';

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return route(async () => {
    const user = await requireUser(request, appContext.store);
    const workspaceId = workspaceHeader(request);
    if (!workspaceId) throw badRequest('WORKSPACE_REQUIRED', 'X-Workspace-Id is required.');
    const { id } = await params;
    const body = await readJson<{ permissions: { permissionId: string; scope: 'OWN' | 'DEPARTMENT' | 'DEPARTMENT_TREE' | 'WORKSPACE' }[] }>(request);
    return appContext.roles.replacePermissions(user, workspaceId, id, body.permissions);
  });
}
