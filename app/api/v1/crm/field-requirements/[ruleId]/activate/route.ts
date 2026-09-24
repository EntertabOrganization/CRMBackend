import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { readJson } from '@/src/server/request';
import { route } from '@/src/server/response';
import { requireWorkspaceContext } from '@/src/server/route-helpers';

export async function POST(request: NextRequest, { params }: { params: Promise<{ ruleId: string }> }) {
  return route(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request, 'configWrite');
    const { ruleId } = await params;
    return appContext.fields.requirements.setActive(user, workspaceId, ruleId, true, await readJson<Record<string, unknown>>(request));
  });
}
