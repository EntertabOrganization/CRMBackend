import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { route } from '@/src/server/response';
import { requireWorkspaceContext } from '@/src/server/route-helpers';

export async function POST(request: NextRequest, { params }: { params: Promise<{ typeId: string }> }) {
  return route(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request, 'configWrite');
    const { typeId } = await params;
    return appContext.activityTypeAdmin.setEnabled(user, workspaceId, typeId, false);
  });
}
