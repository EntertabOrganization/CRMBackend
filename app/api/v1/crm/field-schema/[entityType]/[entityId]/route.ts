import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { route } from '@/src/server/response';
import { fieldEntityTypeFromParam as fieldEntityTypeOf, requireWorkspaceContext } from '@/src/server/route-helpers';

export async function GET(request: NextRequest, { params }: { params: Promise<{ entityType: string; entityId: string }> }) {
  return route(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request);
    const { entityType, entityId } = await params;
    return appContext.fields.schema.getSchema(user, workspaceId, fieldEntityTypeOf(entityType), { surface: request.nextUrl.searchParams.get('surface') ?? undefined, entityId, pipelineId: request.nextUrl.searchParams.get('pipelineId'), stageId: request.nextUrl.searchParams.get('stageId') });
  });
}
