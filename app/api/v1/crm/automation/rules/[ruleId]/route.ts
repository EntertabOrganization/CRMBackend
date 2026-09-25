import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { readJson } from '@/src/server/request';
import { route } from '@/src/server/response';
import { requireWorkspaceContext } from '@/src/server/route-helpers';

type Params = { params: Promise<{ ruleId: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  return route(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request);
    const { ruleId } = await params;
    return appContext.automation.rules.get(user, workspaceId, ruleId);
  });
}

export async function PATCH(request: NextRequest, { params }: Params) {
  return route(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request, 'configWrite');
    const { ruleId } = await params;
    const body = await readJson<Record<string, unknown>>(request);
    return appContext.automation.rules.update(user, workspaceId, ruleId, body);
  });
}

export async function DELETE(request: NextRequest, { params }: Params) {
  return route(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request, 'configWrite');
    const { ruleId } = await params;
    return appContext.automation.rules.remove(user, workspaceId, ruleId);
  });
}
