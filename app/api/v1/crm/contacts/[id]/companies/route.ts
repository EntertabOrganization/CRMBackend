import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { badRequest } from '@/src/server/errors';
import { readJson, requireUser, workspaceHeader } from '@/src/server/request';
import { route } from '@/src/server/response';

type Params = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  return route(async () => {
    const user = await requireUser(request, appContext.store);
    const workspaceId = workspaceHeader(request);
    if (!workspaceId) throw badRequest('WORKSPACE_REQUIRED', 'X-Workspace-Id is required.');
    const { id } = await params;
    const body = await readJson<{ companyId: string; jobTitle?: string | null; department?: string | null; isPrimary?: boolean; sortOrder?: number }>(request);
    return appContext.crmCore.linkContactCompany(user, workspaceId, { ...body, contactId: id });
  });
}
