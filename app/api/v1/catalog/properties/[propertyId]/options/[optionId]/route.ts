import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { readJson } from '@/src/server/request';
import { route } from '@/src/server/response';
import { requireWorkspaceContext } from '@/src/server/route-helpers';

type Params = { params: Promise<{ propertyId: string; optionId: string }> };

export async function PATCH(request: NextRequest, { params }: Params) {
  return route(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request, 'configWrite');
    const { propertyId, optionId } = await params;
    const body = await readJson<Record<string, unknown>>(request);
    return appContext.catalog.properties.updateOption(user, workspaceId, propertyId, optionId, body);
  });
}
