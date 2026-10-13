import { prisma } from '../prisma-client';
import { PackRouter } from '../process-platform/http';
import { WorkflowDefinitionService } from './definition-service';
import { WorkflowExecutionService } from './execution-service';
import { WorkflowAssignmentService } from './assignment-service';
import { WorkflowRuntime } from './runtime';
import { WorkflowTriggerService } from './trigger-service';
import { WorkflowActionsService } from './actions-service';
import { WorkflowCompensationService } from './compensation-service';
import { WorkflowTemplateService } from './template-service';
import { WorkflowGovernanceService } from './governance-service';
import { ResourceTimelineService } from '../activities/resource-timeline-service';

export const workflowDefinitions = new WorkflowDefinitionService(prisma);
export const workflowExecutions = new WorkflowExecutionService(prisma,workflowDefinitions);
export const workflowRuntime = new WorkflowRuntime(prisma,workflowExecutions);
export const workflowAssignments = new WorkflowAssignmentService(prisma,workflowRuntime);
export const workflowTriggers = new WorkflowTriggerService(prisma,workflowExecutions);
export const workflowActionService = new WorkflowActionsService(prisma,workflowExecutions);
export const workflowCompensations = new WorkflowCompensationService(prisma,workflowExecutions);
export const workflowTemplates = new WorkflowTemplateService(prisma,workflowDefinitions);
export const workflowGovernance = new WorkflowGovernanceService(prisma,workflowExecutions);
export const workflowDiscussions = new ResourceTimelineService(prisma,workflowExecutions);
export const workflowRouter = new PackRouter()
  .add('POST','/api/v1/workflows','WorkflowDefinitionsController',c => workflowDefinitions.create(c.actor,c.body),201)
  .add('GET','/api/v1/workflows','WorkflowDefinitionsController',c => workflowDefinitions.list(c.actor,c.query))
  .add('GET','/api/v1/workflows/:workflowId','WorkflowDefinitionsController',c => workflowDefinitions.get(c.actor,c.params.workflowId))
  .add('PATCH','/api/v1/workflows/:workflowId','WorkflowDefinitionsController',c => workflowDefinitions.update(c.actor,c.params.workflowId,c.body))
  .add('POST','/api/v1/workflows/:workflowId/versions','WorkflowVersionsController',c => workflowDefinitions.newVersion(c.actor,c.params.workflowId,c.body),201)
  .add('GET','/api/v1/workflows/:workflowId/versions','WorkflowVersionsController',c => workflowDefinitions.versions(c.actor,c.params.workflowId,c.query))
  .add('GET','/api/v1/workflows/:workflowId/versions/:versionId','WorkflowVersionsController',c => workflowDefinitions.getVersion(c.actor,c.params.workflowId,c.params.versionId))
  .add('POST','/api/v1/workflows/:workflowId/versions/:versionId/validate','WorkflowVersionsController',c => workflowDefinitions.validate(c.actor,c.params.workflowId,c.params.versionId,c.body))
  .add('POST','/api/v1/workflows/:workflowId/versions/:versionId/publish','WorkflowVersionsController',c => workflowDefinitions.publish(c.actor,c.params.workflowId,c.params.versionId,c.body))
  .add('POST','/api/v1/workflows/:workflowId/pause','WorkflowDefinitionsController',c => workflowDefinitions.transition(c.actor,c.params.workflowId,'pause',c.body))
  .add('POST','/api/v1/workflows/:workflowId/archive','WorkflowDefinitionsController',c => workflowDefinitions.transition(c.actor,c.params.workflowId,'archive',c.body))
  .add('GET','/api/v1/workflows/:workflowId/versions/:versionId/graph','WorkflowGraphController',c => workflowDefinitions.getVersion(c.actor,c.params.workflowId,c.params.versionId,true))
  .add('PUT','/api/v1/workflows/:workflowId/versions/:versionId/graph','WorkflowGraphController',c => workflowDefinitions.editGraph(c.actor,c.params.workflowId,c.params.versionId,'REPLACE',c.body))
  .add('POST','/api/v1/workflows/:workflowId/versions/:versionId/graph/nodes','WorkflowGraphController',c => workflowDefinitions.editGraph(c.actor,c.params.workflowId,c.params.versionId,'ADD_NODE',c.body),201)
  .add('PATCH','/api/v1/workflows/:workflowId/versions/:versionId/graph/nodes/:nodeId','WorkflowGraphController',c => workflowDefinitions.editGraph(c.actor,c.params.workflowId,c.params.versionId,'PATCH_NODE',c.body,c.params.nodeId))
  .add('DELETE','/api/v1/workflows/:workflowId/versions/:versionId/graph/nodes/:nodeId','WorkflowGraphController',c => workflowDefinitions.editGraph(c.actor,c.params.workflowId,c.params.versionId,'DELETE_NODE',c.body,c.params.nodeId))
  .add('POST','/api/v1/workflows/:workflowId/versions/:versionId/graph/edges','WorkflowGraphController',c => workflowDefinitions.editGraph(c.actor,c.params.workflowId,c.params.versionId,'ADD_EDGE',c.body),201)
  .add('POST','/api/v1/workflows/:workflowId/versions/:versionId/graph/preview','WorkflowGraphController',c => workflowDefinitions.preview(c.actor,c.params.workflowId,c.params.versionId,c.body))
  .add('POST','/api/v1/workflows/:workflowId/start','WorkflowExecutionsController',c => workflowExecutions.start(c.actor,c.params.workflowId,c.body,c.request.headers.get('idempotency-key')),202)
  .add('GET','/api/v1/workflow-executions','WorkflowExecutionsController',c => workflowExecutions.list(c.actor,c.query))
  .add('GET','/api/v1/workflow-executions/:executionId','WorkflowExecutionsController',c => workflowExecutions.get(c.actor,c.params.executionId))
  .add('GET','/api/v1/workflow-executions/:executionId/nodes','WorkflowExecutionsController',c => workflowExecutions.nodes(c.actor,c.params.executionId,c.query))
  .add('GET','/api/v1/workflow-executions/:executionId/logs','WorkflowExecutionsController',c => workflowExecutions.logs(c.actor,c.params.executionId,c.query))
  .add('POST','/api/v1/workflow-executions/:executionId/cancel','WorkflowExecutionsController',c => workflowExecutions.control(c.actor,c.params.executionId,'cancel',c.body))
  .add('POST','/api/v1/workflow-executions/:executionId/suspend','WorkflowExecutionsController',c => workflowExecutions.control(c.actor,c.params.executionId,'suspend',c.body))
  .add('POST','/api/v1/workflow-executions/:executionId/resume','WorkflowExecutionsController',c => workflowExecutions.control(c.actor,c.params.executionId,'resume',c.body))
  .add('POST','/api/v1/workflow-executions/:executionId/retry','WorkflowExecutionsController',c => workflowExecutions.control(c.actor,c.params.executionId,'retry',c.body))
  .add('POST','/api/v1/workflow-executions/:executionId/terminate','WorkflowExecutionsController',c => workflowExecutions.control(c.actor,c.params.executionId,'terminate',c.body))
  .add('GET','/api/v1/workflow-assignments/my','WorkflowAssignmentsController',c => workflowAssignments.my(c.actor,c.query))
  .add('GET','/api/v1/workflow-assignments/:assignmentId','WorkflowAssignmentsController',c => workflowAssignments.get(c.actor,c.params.assignmentId))
  .add('POST','/api/v1/workflow-assignments/:assignmentId/decide','WorkflowAssignmentsController',c => workflowAssignments.decide(c.actor,c.params.assignmentId,c.body,c.request.headers.get('idempotency-key')))
  .add('POST','/api/v1/workflow-assignments/:assignmentId/delegate','WorkflowAssignmentsController',c => workflowAssignments.delegate(c.actor,c.params.assignmentId,c.body))
  .add('POST','/api/v1/workflow-assignments/:assignmentId/submit-information','WorkflowAssignmentsController',c => workflowAssignments.decide(c.actor,c.params.assignmentId,c.body,c.request.headers.get('idempotency-key'),true))
  .add('GET','/api/v1/workflow-assignments/:assignmentId/history','WorkflowAssignmentsController',c => workflowAssignments.history(c.actor,c.params.assignmentId,c.query))
  .add('GET','/api/v1/workflows/:workflowId/triggers','WorkflowTriggersController',c => workflowTriggers.get(c.actor,c.params.workflowId))
  .add('PUT','/api/v1/workflows/:workflowId/triggers','WorkflowTriggersController',c => workflowTriggers.update(c.actor,c.params.workflowId,c.body))
  .add('GET','/api/v1/workflow-executions/:executionId/waits','WorkflowTriggersController',c => workflowTriggers.waits(c.actor,c.params.executionId))
  .add('GET','/api/v1/workflows/runtime-limits','WorkflowRuntimePolicyController',c => workflowTriggers.runtimeLimits(c.actor))
  .add('PUT','/api/v1/workflows/runtime-limits','WorkflowRuntimePolicyController',c => workflowTriggers.setLimits(c.actor,c.body))
  .add('GET','/api/v1/workflows/actions','WorkflowActionsController',c => workflowActionService.list(c.actor,c.query))
  .add('POST','/api/v1/workflows/:workflowId/actions/:actionCode/validate','WorkflowActionsController',c => workflowActionService.validate(c.actor,c.params.workflowId,c.params.actionCode,c.body))
  .addPublic('POST','/api/v1/workflows/callbacks/:token','WorkflowActionsController',c => workflowRuntime.callbacks.receive(c.params.token,c.body,c.request.headers.get('x-workflow-signature')),202)
  .add('GET','/api/v1/workflow-executions/:executionId/actions','WorkflowActionsController',c => workflowActionService.invocations(c.actor,c.params.executionId,c.query))
  .add('GET','/api/v1/workflow-executions/:executionId/children','WorkflowCompensationController',c => workflowCompensations.children(c.actor,c.params.executionId))
  .add('GET','/api/v1/workflow-executions/:executionId/compensations','WorkflowCompensationController',c => workflowCompensations.list(c.actor,c.params.executionId))
  .add('POST','/api/v1/workflow-executions/:executionId/compensate','WorkflowCompensationController',c => workflowCompensations.request(c.actor,c.params.executionId,c.body,c.request.headers.get('idempotency-key')),202)
  .add('POST','/api/v1/workflow-executions/:executionId/compensations/:actionId/retry','WorkflowCompensationController',c => workflowCompensations.request(c.actor,c.params.executionId,c.body,c.request.headers.get('idempotency-key'),c.params.actionId),202)
  .add('GET','/api/v1/workflow-templates','WorkflowTemplatesController',c => workflowTemplates.list(c.actor,c.query))
  .add('POST','/api/v1/workflow-templates','WorkflowTemplatesController',c => workflowTemplates.create(c.actor,c.body),201)
  .add('POST','/api/v1/workflow-templates/:templateId/instantiate','WorkflowTemplatesController',c => workflowTemplates.instantiate(c.actor,c.params.templateId,c.body),201)
  .add('GET','/api/v1/workflows/admin/health','WorkflowAdminController',c => workflowGovernance.health(c.actor,c.query))
  .add('POST','/api/v1/workflows/admin/reconcile','WorkflowAdminController',c => workflowGovernance.reconcile(c.actor,c.body,c.request.headers.get('idempotency-key')),202)
  .add('GET','/api/v1/workflow-executions/:executionId/discussion','WorkflowAdminController',c => workflowDiscussions.reference(c.actor,c.params.executionId));
