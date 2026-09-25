import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { readJson } from '@/src/server/request';
import { route } from '@/src/server/response';
import { requireWorkspaceContext } from '@/src/server/route-helpers';

type Params = { params: Promise<{ productId: string; ratioId: string }> };

export async function PATCH(request: NextRequest, { params }: Params) {
  return route(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request, 'configWrite');
    const { productId, ratioId } = await params;
    const body = await readJson<Record<string, unknown>>(request);
    return appContext.catalog.products.updateRatio(user, workspaceId, productId, ratioId, body);
  });
}

export async function DELETE(request: NextRequest, { params }: Params) {
  return route(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request, 'configWrite');
    const { productId, ratioId } = await params;
    return appContext.catalog.products.deleteRatio(user, workspaceId, productId, ratioId);
  });
}
