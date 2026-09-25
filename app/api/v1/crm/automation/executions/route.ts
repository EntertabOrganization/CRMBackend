import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { routeWithMeta } from '@/src/server/response';
import { requireWorkspaceContext } from '@/src/server/route-helpers';

export async function GET(request: NextRequest) {
  return routeWithMeta(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request);
    return appContext.automation.execution.listExecutions(user, workspaceId, request.nextUrl.searchParams);
  });
}
