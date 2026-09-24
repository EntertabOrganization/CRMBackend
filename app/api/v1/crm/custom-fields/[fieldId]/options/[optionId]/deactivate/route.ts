import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { route } from '@/src/server/response';
import { requireWorkspaceContext } from '@/src/server/route-helpers';

export async function POST(request: NextRequest, { params }: { params: Promise<{ fieldId: string; optionId: string }> }) {
  return route(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request, 'configWrite');
    const { fieldId, optionId } = await params;
    return appContext.fields.definitions.setOptionActive(user, workspaceId, fieldId, optionId, false);
  });
}
