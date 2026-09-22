import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { readJson, requireUser } from '@/src/server/request';
import { route } from '@/src/server/response';

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  return route(async () => {
    const user = await requireUser(request, appContext.store);
    const { id } = await params;
    return appContext.workspaces.assertMembership(user.id, id).workspace;
  });
}

export async function PUT(request: NextRequest, { params }: Params) {
  return PATCH(request, { params });
}

export async function PATCH(request: NextRequest, { params }: Params) {
  return route(async () => {
    const user = await requireUser(request, appContext.store);
    const { id } = await params;
    return appContext.workspaces.updateWorkspace(user, id, await readJson(request));
  });
}

export async function DELETE(request: NextRequest, { params }: Params) {
  return route(async () => {
    const user = await requireUser(request, appContext.store);
    const { id } = await params;
    return appContext.workspaces.softDelete(user, id);
  });
}
