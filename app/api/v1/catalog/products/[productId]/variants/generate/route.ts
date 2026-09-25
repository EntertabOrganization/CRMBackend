import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { readJson } from '@/src/server/request';
import { route } from '@/src/server/response';
import { requireWorkspaceContext, idempotencyKeyOf } from '@/src/server/route-helpers';

type Params = { params: Promise<{ productId: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  return route(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request, 'bulk');
    const { productId } = await params;
    const body = await readJson<Record<string, unknown>>(request);
    return appContext.catalog.matrix.generate(user, workspaceId, productId, body, idempotencyKeyOf(request));
  });
}
