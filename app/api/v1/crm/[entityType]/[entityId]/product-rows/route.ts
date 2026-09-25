import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { readJson } from '@/src/server/request';
import { route } from '@/src/server/response';
import { requireWorkspaceContext, idempotencyKeyOf } from '@/src/server/route-helpers';

type Params = { params: Promise<{ entityType: string; entityId: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  return route(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request);
    const { entityType, entityId } = await params;
    return appContext.catalog.rows.list(user, workspaceId, entityType, entityId);
  });
}

export async function PUT(request: NextRequest, { params }: Params) {
  return route(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request, 'configWrite');
    const { entityType, entityId } = await params;
    const body = await readJson<Record<string, unknown>>(request);
    return appContext.catalog.rows.replace(user, workspaceId, entityType, entityId, body, idempotencyKeyOf(request));
  });
}
