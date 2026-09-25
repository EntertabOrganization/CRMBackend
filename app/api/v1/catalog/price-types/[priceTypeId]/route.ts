import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { readJson } from '@/src/server/request';
import { route } from '@/src/server/response';
import { requireWorkspaceContext } from '@/src/server/route-helpers';

type Params = { params: Promise<{ priceTypeId: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  return route(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request);
    const { priceTypeId } = await params;
    return appContext.catalog.priceTypes.get(user, workspaceId, priceTypeId);
  });
}

export async function PATCH(request: NextRequest, { params }: Params) {
  return route(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request, 'configWrite');
    const { priceTypeId } = await params;
    const body = await readJson<Record<string, unknown>>(request);
    return appContext.catalog.priceTypes.update(user, workspaceId, priceTypeId, body);
  });
}
