import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { readJson } from '@/src/server/request';
import { route, routeWithMeta } from '@/src/server/response';
import { idempotencyKeyOf, requireWorkspaceContext } from '@/src/server/route-helpers';

export async function GET(request: NextRequest) {
  return routeWithMeta(async () => {
    const { user, workspaceId, actor } = await requireWorkspaceContext(request);
    const result = appContext.crmCore.listCompanies(user, workspaceId, request.nextUrl.searchParams);
    return { data: appContext.fields.decorate(actor, 'COMPANY', result.data), meta: result.meta };
  });
}

export async function POST(request: NextRequest) {
  return route(async () => {
    const { user, workspaceId, actor } = await requireWorkspaceContext(request);
    const record = appContext.crmCore.createCompany(user, workspaceId, (await readJson(request)) as never);
    return appContext.fields.decorate(actor, 'COMPANY', [record])[0];
  });
}