import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { readJson } from '@/src/server/request';
import { route } from '@/src/server/response';
import { requireWorkspaceContext, idempotencyKeyOf } from '@/src/server/route-helpers';

type Params = { params: Promise<{ variantId: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  return route(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request);
    const { variantId } = await params;
    return appContext.catalog.products.getPrices(user, workspaceId, variantId, 'VARIANT');
  });
}

export async function PUT(request: NextRequest, { params }: Params) {
  return route(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request, 'configWrite');
    const { variantId } = await params;
    const body = await readJson<Record<string, unknown>>(request);
    return appContext.catalog.products.putPrices(user, workspaceId, variantId, 'VARIANT', body, idempotencyKeyOf(request));
  });
}
