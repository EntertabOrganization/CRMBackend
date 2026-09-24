import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { readJson } from '@/src/server/request';
import { route } from '@/src/server/response';
import { requireWorkspaceContext } from '@/src/server/route-helpers';

export async function GET(request: NextRequest, { params }: { params: Promise<{ ruleId: string }> }) {
  return route(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request);
    const { ruleId } = await params;
    return appContext.fields.requirements.get(user, workspaceId, ruleId);
  });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ ruleId: string }> }) {
  return route(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request, 'configWrite');
    const { ruleId } = await params;
    return appContext.fields.requirements.update(user, workspaceId, ruleId, await readJson<Record<string, unknown>>(request));
  });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ ruleId: string }> }) {
  return route(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request, 'configWrite');
    const { ruleId } = await params;
    return appContext.fields.requirements.delete(user, workspaceId, ruleId);
  });
}
