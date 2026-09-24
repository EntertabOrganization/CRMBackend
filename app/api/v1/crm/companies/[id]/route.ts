import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { readJson } from '@/src/server/request';
import { route } from '@/src/server/response';
import { idempotencyKeyOf, requireWorkspaceContext } from '@/src/server/route-helpers';

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  return route(async () => {
    const { user, workspaceId, actor } = await requireWorkspaceContext(request);
    const { id } = await params;
    return appContext.fields.decorate(actor, 'COMPANY', [appContext.crmCore.getRecord(user, workspaceId, 'COMPANY', id)])[0];
  });
}

export async function PATCH(request: NextRequest, { params }: Params) {
  return route(async () => {
    const { user, workspaceId, actor } = await requireWorkspaceContext(request);
    const { id } = await params;
    const record = appContext.crmCore.updateRecord(user, workspaceId, 'COMPANY', id, await readJson<Record<string, unknown>>(request), idempotencyKeyOf(request));
    return appContext.fields.decorate(actor, 'COMPANY', [record])[0];
  });
}

export async function DELETE(request: NextRequest, { params }: Params) {
  return route(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request);
    const { id } = await params;
    return appContext.crmCore.softDeleteCompany(user, workspaceId, id);
  });
}