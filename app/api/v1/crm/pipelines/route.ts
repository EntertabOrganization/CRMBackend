import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { badRequest } from '@/src/server/errors';
import { readJson, requireUser, workspaceHeader } from '@/src/server/request';
import { route } from '@/src/server/response';
import type { CrmPipelineEntityType, CrmStageSemanticType } from '@/src/server/domain';

type PipelineBody = {
  entityType: CrmPipelineEntityType;
  name: string;
  isDefault?: boolean;
  transitionRulesEnabled?: boolean;
  stages: { name: string; semanticType: CrmStageSemanticType; isDefault?: boolean; position?: number }[];
};

export async function GET(request: NextRequest) {
  return route(async () => {
    const user = await requireUser(request, appContext.store);
    const workspaceId = workspaceHeader(request);
    if (!workspaceId) throw badRequest('WORKSPACE_REQUIRED', 'X-Workspace-Id is required.');
    const entityType = request.nextUrl.searchParams.get('entityType') as CrmPipelineEntityType | null;
    return appContext.crm.listPipelines(user, workspaceId, entityType ?? undefined);
  });
}

export async function POST(request: NextRequest) {
  return route(async () => {
    const user = await requireUser(request, appContext.store);
    const workspaceId = workspaceHeader(request);
    if (!workspaceId) throw badRequest('WORKSPACE_REQUIRED', 'X-Workspace-Id is required.');
    return appContext.crm.createPipeline(user, workspaceId, await readJson<PipelineBody>(request));
  });
}
