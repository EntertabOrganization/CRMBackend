import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { readJson } from '@/src/server/request';
import { route } from '@/src/server/response';
import { requireWorkspaceContext } from '@/src/server/route-helpers';

export async function GET(request: NextRequest, { params }: { params: Promise<{ typeId: string }> }) {
  return route(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request);
    const { typeId } = await params;
    return appContext.activityTypeAdmin.get(user, workspaceId, typeId);
  });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ typeId: string }> }) {
  return route(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request, 'configWrite');
    const { typeId } = await params;
    return appContext.activityTypeAdmin.update(user, workspaceId, typeId, await readJson<Record<string, unknown>>(request));
  });
}
