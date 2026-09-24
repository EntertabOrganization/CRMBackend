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
    const pipelines = appContext.crm.listPipelines(user, workspaceId, entityType ?? undefined);
    // Opt-in so existing clients keep the plain list; the settings UI needs stages to scope requirement rules.
    if (request.nextUrl.searchParams.get('includeStages') !== 'true') return pipelines;
    return pipelines.map((pipeline) => ({
      ...pipeline,
      stages: appContext.store.state.crmStages
        .filter((stage) => stage.pipelineId === pipeline.id && stage.isActive)
        .sort((a, b) => a.position - b.position)
        .map((stage) => ({ id: stage.id, name: stage.name, semanticType: stage.semanticType, position: stage.position })),
    }));
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
