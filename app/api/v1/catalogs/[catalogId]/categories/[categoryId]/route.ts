import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { readJson } from '@/src/server/request';
import { route } from '@/src/server/response';
import { requireWorkspaceContext } from '@/src/server/route-helpers';

type Params = { params: Promise<{ catalogId: string; categoryId: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  return route(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request);
    const { catalogId, categoryId } = await params;
    return appContext.catalog.categories.get(user, workspaceId, catalogId, categoryId);
  });
}

export async function PATCH(request: NextRequest, { params }: Params) {
  return route(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request, 'configWrite');
    const { catalogId, categoryId } = await params;
    const body = await readJson<Record<string, unknown>>(request);
    return appContext.catalog.categories.update(user, workspaceId, catalogId, categoryId, body);
  });
}

export async function DELETE(request: NextRequest, { params }: Params) {
  return route(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request, 'configWrite');
    const { catalogId, categoryId } = await params;
    return appContext.catalog.categories.remove(user, workspaceId, catalogId, categoryId);
  });
}
