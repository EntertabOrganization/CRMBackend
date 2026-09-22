import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { readJson, requireUser } from '@/src/server/request';
import { route } from '@/src/server/response';

export async function GET(request: NextRequest) {
  return route(async () => {
    const user = await requireUser(request, appContext.store);
    return appContext.store.state.workspaces.filter((workspace) =>
      !workspace.isDeleted &&
      appContext.store.state.workspaceMemberships.some((membership) => membership.userId === user.id && membership.workspaceId === workspace.id && !membership.isDeleted),
    );
  });
}

export async function POST(request: NextRequest) {
  return route(async () => {
    const user = await requireUser(request, appContext.store);
    const body = await readJson<{ name: string }>(request);
    return appContext.workspaces.createOwnedWorkspace(user, body.name);
  });
}
