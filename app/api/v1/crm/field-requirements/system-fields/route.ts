import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { route } from '@/src/server/response';
import { requireWorkspaceContext } from '@/src/server/route-helpers';

export async function GET(request: NextRequest) {
  return route(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request);
    return appContext.fields.requirements.systemFields(user, workspaceId, request.nextUrl.searchParams.get('entityType') ?? '');
  });
}
