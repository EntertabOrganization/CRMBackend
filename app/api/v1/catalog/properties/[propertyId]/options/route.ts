import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { readJson } from '@/src/server/request';
import { route } from '@/src/server/response';
import { requireWorkspaceContext } from '@/src/server/route-helpers';

type Params = { params: Promise<{ propertyId: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  return route(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request);
    const { propertyId } = await params;
    return appContext.catalog.properties.listOptions(user, workspaceId, propertyId);
  });
}

export async function POST(request: NextRequest, { params }: Params) {
  return route(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request, 'configWrite');
    const { propertyId } = await params;
    const body = await readJson<Record<string, unknown>>(request);
    return appContext.catalog.properties.createOption(user, workspaceId, propertyId, body);
  });
}
