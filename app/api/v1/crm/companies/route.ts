import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { badRequest } from '@/src/server/errors';
import { readJson, requireUser, workspaceHeader } from '@/src/server/request';
import { route, routeWithMeta } from '@/src/server/response';

export async function GET(request: NextRequest) {
  return routeWithMeta(async () => {
    const user = await requireUser(request, appContext.store);
    const workspaceId = workspaceHeader(request);
    if (!workspaceId) throw badRequest('WORKSPACE_REQUIRED', 'X-Workspace-Id is required.');
    return appContext.crmCore.listCompanies(user, workspaceId, request.nextUrl.searchParams);
  });
}

export async function POST(request: NextRequest) {
  return route(async () => {
    const user = await requireUser(request, appContext.store);
    const workspaceId = workspaceHeader(request);
    if (!workspaceId) throw badRequest('WORKSPACE_REQUIRED', 'X-Workspace-Id is required.');
    return appContext.crmCore.createCompany(user, workspaceId, await readJson(request));
  });
}
