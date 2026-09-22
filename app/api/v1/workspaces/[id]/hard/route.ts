import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { requireUser } from '@/src/server/request';
import { route } from '@/src/server/response';

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return route(async () => {
    const user = await requireUser(request, appContext.store);
    const { id } = await params;
    return appContext.workspaces.hardDelete(user, id);
  });
}
