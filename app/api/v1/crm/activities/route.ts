import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { readJson } from '@/src/server/request';
import { route, routeWithMeta } from '@/src/server/response';
import { idempotencyKeyOf, requireWorkspaceContext } from '@/src/server/route-helpers';

export async function POST(request: NextRequest) {
  return route(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request);
    return appContext.activities.create(user, workspaceId, await readJson<Record<string, unknown>>(request), idempotencyKeyOf(request));
  });
}

export async function GET(request: NextRequest) {
  return routeWithMeta(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request);
    return appContext.activities.list(user, workspaceId, request.nextUrl.searchParams);
  });
}
