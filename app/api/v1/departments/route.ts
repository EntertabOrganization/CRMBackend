import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { readJson, requireUser, workspaceHeader } from '@/src/server/request';
import { badRequest } from '@/src/server/errors';
import { route } from '@/src/server/response';

export async function GET(request: NextRequest) {
  return route(async () => {
    const user = await requireUser(request, appContext.store);
    const workspaceId = workspaceHeader(request);
    if (!workspaceId) throw badRequest('WORKSPACE_REQUIRED', 'X-Workspace-Id is required.');
    return appContext.departments.tree(user, workspaceId);
  });
}

export async function POST(request: NextRequest) {
  return route(async () => {
    const user = await requireUser(request, appContext.store);
    const workspaceId = workspaceHeader(request);
    if (!workspaceId) throw badRequest('WORKSPACE_REQUIRED', 'X-Workspace-Id is required.');
    return appContext.departments.create(user, workspaceId, await readJson(request));
  });
}
