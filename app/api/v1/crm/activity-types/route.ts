import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { readJson } from '@/src/server/request';
import { route } from '@/src/server/response';
import { requireWorkspaceContext } from '@/src/server/route-helpers';

export async function POST(request: NextRequest) {
  return route(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request, 'configWrite');
    return appContext.activityTypeAdmin.create(user, workspaceId, await readJson<Record<string, unknown>>(request));
  });
}

export async function GET(request: NextRequest) {
  return route(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request);
    return appContext.activityTypeAdmin.list(user, workspaceId);
  });
}
