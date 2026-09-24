import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { readJson } from '@/src/server/request';
import { route } from '@/src/server/response';
import { idempotencyKeyOf, requireWorkspaceContext } from '@/src/server/route-helpers';

export async function POST(request: NextRequest) {
  return route(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request, 'bulk');
    return appContext.activities.bulk(user, workspaceId, { idempotencyKey: idempotencyKeyOf(request), ...(await readJson<Record<string, unknown>>(request)) });
  });
}
