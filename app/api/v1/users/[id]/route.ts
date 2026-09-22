import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { readJson, requireUser, workspaceHeader } from '@/src/server/request';
import { route } from '@/src/server/response';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return route(async () => {
    const user = await requireUser(request, appContext.store);
    const { id } = await params;
    return appContext.users.get(user, id, workspaceHeader(request));
  });
}

export async function PUT(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return PATCH(request, context);
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return route(async () => {
    const user = await requireUser(request, appContext.store);
    const { id } = await params;
    return appContext.users.updateProfile(user, id, await readJson(request));
  });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return route(async () => {
    const user = await requireUser(request, appContext.store);
    const { id } = await params;
    return appContext.users.softDelete(user, id);
  });
}
