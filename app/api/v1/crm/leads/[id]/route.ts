import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { readJson } from '@/src/server/request';
import { route } from '@/src/server/response';
import { idempotencyKeyOf, requireWorkspaceContext } from '@/src/server/route-helpers';

function withFields<T extends { id: string }>(actor: Parameters<typeof appContext.fields.decorate>[0], entityType: string, record: T) {
  return appContext.fields.decorate(actor, entityType, [record])[0];
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return route(async () => {
    const { user, workspaceId, actor } = await requireWorkspaceContext(request);
    const { id } = await params;
    return withFields(actor, 'LEAD', appContext.crmCore.getRecord(user, workspaceId, 'LEAD', id));
  });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return route(async () => {
    const { user, workspaceId, actor } = await requireWorkspaceContext(request);
    const { id } = await params;
    return withFields(actor, 'LEAD', appContext.crmCore.updateRecord(user, workspaceId, 'LEAD', id, await readJson<Record<string, unknown>>(request), idempotencyKeyOf(request)));
  });
}
