import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { readJson } from '@/src/server/request';
import { route } from '@/src/server/response';
import { requireWorkspaceContext } from '@/src/server/route-helpers';

export async function GET(request: NextRequest, { params }: { params: Promise<{ fieldId: string }> }) {
  return route(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request);
    const { fieldId } = await params;
    return appContext.fields.definitions.get(user, workspaceId, fieldId);
  });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ fieldId: string }> }) {
  return route(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request, 'configWrite');
    const { fieldId } = await params;
    return appContext.fields.definitions.update(user, workspaceId, fieldId, await readJson<Record<string, unknown>>(request));
  });
}
