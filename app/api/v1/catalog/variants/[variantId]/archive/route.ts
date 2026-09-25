import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { readJson } from '@/src/server/request';
import { route } from '@/src/server/response';
import { requireWorkspaceContext } from '@/src/server/route-helpers';

type Params = { params: Promise<{ variantId: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  return route(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request, 'configWrite');
    const { variantId } = await params;
    const body = await readJson<Record<string, unknown>>(request);
    return appContext.catalog.products.archive(user, workspaceId, variantId, 'VARIANT', body);
  });
}
