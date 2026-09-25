import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { readJson } from '@/src/server/request';
import { route, routeWithMeta } from '@/src/server/response';
import { requireWorkspaceContext, idempotencyKeyOf } from '@/src/server/route-helpers';

type Params = { params: Promise<{ productId: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  return routeWithMeta(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request);
    const { productId } = await params;
    return appContext.catalog.products.listVariants(user, workspaceId, productId, request.nextUrl.searchParams);
  });
}

export async function POST(request: NextRequest, { params }: Params) {
  return route(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request, 'configWrite');
    const { productId } = await params;
    const body = await readJson<Record<string, unknown>>(request);
    return appContext.catalog.products.createVariant(user, workspaceId, productId, body, idempotencyKeyOf(request));
  });
}
