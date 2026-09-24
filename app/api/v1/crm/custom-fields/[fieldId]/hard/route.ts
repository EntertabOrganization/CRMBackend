import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { route } from '@/src/server/response';
import { requireWorkspaceContext } from '@/src/server/route-helpers';

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ fieldId: string }> }) {
  return route(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request, 'configWrite');
    const { fieldId } = await params;
    return appContext.fields.definitions.hardDelete(user, workspaceId, fieldId);
  });
}
