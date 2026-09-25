import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { route } from '@/src/server/response';
import { requireWorkspaceContext } from '@/src/server/route-helpers';

type Params = { params: Promise<{ catalogId: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  return route(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request, 'configWrite');
    const { catalogId } = await params;
    return appContext.catalog.catalogs.setDefault(user, workspaceId, catalogId);
  });
}
