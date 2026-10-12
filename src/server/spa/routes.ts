import { prisma } from '../prisma-client';
import { PackRouter } from '../process-platform/http';
import { SpaTypeService } from './type-service';
import { SpaSchemaService } from './schema-service';
import { SpaPipelineService } from './pipeline-service';
import { SpaPolicyService } from './policy-service';
import { SpaNumberingService } from './numbering-service';
import { SpaItemService } from './item-service';
import { SpaMigrationService } from './migration-service';
import { SpaRecurrenceService } from './recurrence-service';
import { SpaRelationService } from './relation-service';
import { SpaTransferService } from './transfer-service';

const types = new SpaTypeService(prisma);
const schemas = new SpaSchemaService(prisma);
const pipelines = new SpaPipelineService(prisma);
const policies = new SpaPolicyService(prisma);
const numbering = new SpaNumberingService(prisma);
const items = new SpaItemService(prisma);
const migrations = new SpaMigrationService(prisma);
const recurrence = new SpaRecurrenceService(prisma);
const relations = new SpaRelationService(prisma);
const transfers = new SpaTransferService(prisma);
export const spaRouter = new PackRouter()
  .add('POST', '/api/v1/spa/types', 'SpaTypesController', context => types.create(context.actor, context.body), 201)
  .add('GET', '/api/v1/spa/types', 'SpaTypesController', context => types.list(context.actor, context.query))
  .add('GET', '/api/v1/spa/types/:typeId', 'SpaTypesController', context => types.get(context.actor, context.params.typeId))
  .add('PATCH', '/api/v1/spa/types/:typeId', 'SpaTypesController', context => types.update(context.actor, context.params.typeId, context.body))
  .add('POST', '/api/v1/spa/types/:typeId/activate', 'SpaTypesController', context => types.transition(context.actor, context.params.typeId, 'activate', context.body))
  .add('POST', '/api/v1/spa/types/:typeId/archive', 'SpaTypesController', context => types.transition(context.actor, context.params.typeId, 'archive', context.body))
  .add('POST', '/api/v1/spa/types/:typeId/restore', 'SpaTypesController', context => types.transition(context.actor, context.params.typeId, 'restore', context.body))
  .add('GET', '/api/v1/spa/types/:typeId/capabilities', 'SpaCapabilitiesController', context => types.capabilities(context.actor, context.params.typeId))
  .add('PUT', '/api/v1/spa/types/:typeId/capabilities/:key', 'SpaCapabilitiesController', context => types.setCapability(context.actor, context.params.typeId, context.params.key, context.body))
  .add('GET', '/api/v1/spa/types/:typeId/fields', 'SpaFieldsController', c => schemas.fields(c.actor, c.params.typeId))
  .add('POST', '/api/v1/spa/types/:typeId/fields', 'SpaFieldsController', c => schemas.addField(c.actor, c.params.typeId, c.body), 201)
  .add('PATCH', '/api/v1/spa/types/:typeId/fields/:fieldId', 'SpaFieldsController', c => schemas.editField(c.actor, c.params.typeId, c.params.fieldId, c.body))
  .add('POST', '/api/v1/spa/types/:typeId/fields/:fieldId/deactivate', 'SpaFieldsController', c => schemas.editField(c.actor, c.params.typeId, c.params.fieldId, c.body, true))
  .add('GET', '/api/v1/spa/types/:typeId/schema/draft', 'SpaSchemasController', c => schemas.draft(c.actor, c.params.typeId))
  .add('PATCH', '/api/v1/spa/types/:typeId/schema/draft', 'SpaSchemasController', c => schemas.changeDraft(c.actor, c.params.typeId, c.body))
  .add('POST', '/api/v1/spa/types/:typeId/schema/validate', 'SpaSchemasController', c => schemas.validate(c.actor, c.params.typeId, c.body))
  .add('POST', '/api/v1/spa/types/:typeId/schema/publish', 'SpaSchemasController', c => schemas.publish(c.actor, c.params.typeId, c.body))
  .add('GET', '/api/v1/spa/types/:typeId/schema/versions', 'SpaSchemasController', c => schemas.versions(c.actor, c.params.typeId, c.query))
  .add('POST', '/api/v1/spa/types/:typeId/unique-constraints', 'SpaSchemasController', c => schemas.uniqueConstraint(c.actor, c.params.typeId, c.body), 201)
  .add('GET', '/api/v1/spa/types/:typeId/pipelines', 'SpaPipelinesController', c => pipelines.list(c.actor, c.params.typeId, c.query))
  .add('POST', '/api/v1/spa/types/:typeId/pipelines', 'SpaPipelinesController', c => pipelines.create(c.actor, c.params.typeId, c.body), 201)
  .add('PATCH', '/api/v1/spa/types/:typeId/pipelines/:pipelineId', 'SpaPipelinesController', c => pipelines.update(c.actor, c.params.typeId, c.params.pipelineId, c.body))
  .add('GET', '/api/v1/spa/types/:typeId/pipelines/:pipelineId/stages', 'SpaStagesController', c => pipelines.stages(c.actor, c.params.typeId, c.params.pipelineId))
  .add('POST', '/api/v1/spa/types/:typeId/pipelines/:pipelineId/stages', 'SpaStagesController', c => pipelines.createStage(c.actor, c.params.typeId, c.params.pipelineId, c.body), 201)
  .add('PATCH', '/api/v1/spa/types/:typeId/pipelines/:pipelineId/stages/:stageId', 'SpaStagesController', c => pipelines.updateStage(c.actor, c.params.typeId, c.params.pipelineId, c.params.stageId, c.body))
  .add('GET', '/api/v1/spa/types/:typeId/permissions', 'SpaPermissionsController', c => policies.matrix(c.actor, c.params.typeId))
  .add('PUT', '/api/v1/spa/types/:typeId/permissions', 'SpaPermissionsController', c => policies.replace(c.actor, c.params.typeId, c.body))
  .add('GET', '/api/v1/spa/types/:typeId/permissions/history', 'SpaPermissionsController', c => policies.history(c.actor, c.params.typeId, c.query))
  .add('GET', '/api/v1/spa/types/:typeId/numbering', 'SpaNumberingController', c => numbering.get(c.actor, c.params.typeId))
  .add('PUT', '/api/v1/spa/types/:typeId/numbering', 'SpaNumberingController', c => numbering.update(c.actor, c.params.typeId, c.body))
  .add('POST', '/api/v1/spa/types/:typeId/items', 'SpaItemsController', c => items.create(c.actor, c.params.typeId, c.body, c.request.headers.get('idempotency-key')), 201)
  .add('GET', '/api/v1/spa/types/:typeId/items', 'SpaItemsController', c => items.list(c.actor, c.params.typeId, c.query))
  .add('GET', '/api/v1/spa/types/:typeId/items/:itemId', 'SpaItemsController', c => items.get(c.actor, c.params.typeId, c.params.itemId))
  .add('PUT', '/api/v1/spa/types/:typeId/items/:itemId', 'SpaItemsController', c => items.update(c.actor, c.params.typeId, c.params.itemId, c.body, true))
  .add('PATCH', '/api/v1/spa/types/:typeId/items/:itemId', 'SpaItemsController', c => items.update(c.actor, c.params.typeId, c.params.itemId, c.body))
  .add('PATCH', '/api/v1/spa/types/:typeId/items/:itemId/assign', 'SpaItemsController', c => items.assign(c.actor, c.params.typeId, c.params.itemId, c.body))
  .add('POST', '/api/v1/spa/types/:typeId/items/:itemId/observers', 'SpaItemsController', c => items.observer(c.actor, c.params.typeId, c.params.itemId, c.body))
  .add('DELETE', '/api/v1/spa/types/:typeId/items/:itemId/observers/:userId', 'SpaItemsController', c => items.observer(c.actor, c.params.typeId, c.params.itemId, { userId: c.params.userId }, true))
  .add('GET', '/api/v1/spa/types/:typeId/items/:itemId/history', 'SpaItemsController', c => items.itemHistory(c.actor, c.params.typeId, c.params.itemId, c.query))
  .add('DELETE', '/api/v1/spa/types/:typeId/items/:itemId', 'SpaItemsController', c => items.lifecycle(c.actor, c.params.typeId, c.params.itemId, c.body))
  .add('POST', '/api/v1/spa/types/:typeId/items/:itemId/restore', 'SpaItemsController', c => items.lifecycle(c.actor, c.params.typeId, c.params.itemId, c.body, true))
  .add('GET', '/api/v1/spa/types/:typeId/items/:itemId/permissions/me', 'SpaPermissionsController', c => items.permissionsMe(c.actor, c.params.typeId, c.params.itemId))
  .add('POST', '/api/v1/spa/types/:typeId/items/:itemId/transition', 'SpaPipelinesController', c => items.transition(c.actor, c.params.typeId, c.params.itemId, c.body))
  .add('GET', '/api/v1/spa/types/:typeId/kanban', 'SpaPipelinesController', c => items.kanban(c.actor, c.params.typeId, c.query))
  .add('POST', '/api/v1/spa/types/:typeId/pipelines/:pipelineId/archive', 'SpaPipelinesController', c => pipelines.archive(c.actor, c.params.typeId, c.params.pipelineId, c.body))
  .add('POST', '/api/v1/spa/types/:typeId/pipelines/:pipelineId/stages/:stageId/archive', 'SpaStagesController', c => pipelines.archive(c.actor, c.params.typeId, c.params.pipelineId, c.body, c.params.stageId))
  .add('POST', '/api/v1/spa/types/:typeId/schema/migrations', 'SpaSchemasController', c => migrations.queue(c.actor, c.params.typeId, c.body), 202)
  .add('GET', '/api/v1/spa/types/:typeId/recurrence', 'SpaRecurrenceController', c => recurrence.list(c.actor, c.params.typeId, c.query))
  .add('POST', '/api/v1/spa/types/:typeId/recurrence', 'SpaRecurrenceController', c => recurrence.create(c.actor, c.params.typeId, c.body), 201)
  .add('PATCH', '/api/v1/spa/types/:typeId/recurrence/:ruleId', 'SpaRecurrenceController', c => recurrence.update(c.actor, c.params.typeId, c.params.ruleId, c.body))
  .add('POST', '/api/v1/spa/types/:typeId/recurrence/:ruleId/pause', 'SpaRecurrenceController', c => recurrence.pause(c.actor, c.params.typeId, c.params.ruleId))
  .add('POST', '/api/v1/spa/types/:typeId/recurrence/:ruleId/resume', 'SpaRecurrenceController', c => recurrence.pause(c.actor, c.params.typeId, c.params.ruleId, true))
  .add('GET', '/api/v1/spa/types/:typeId/recurrence/:ruleId/instances', 'SpaRecurrenceController', c => recurrence.instances(c.actor, c.params.typeId, c.params.ruleId, c.query))
  .add('GET', '/api/v1/spa/types/:typeId/relation-definitions', 'SpaRelationsController', c => relations.definitions(c.actor, c.params.typeId))
  .add('POST', '/api/v1/spa/types/:typeId/relation-definitions', 'SpaRelationsController', c => relations.addDefinition(c.actor, c.params.typeId, c.body), 201)
  .add('GET', '/api/v1/spa/types/:typeId/items/:itemId/relations', 'SpaRelationsController', c => relations.list(c.actor, c.params.typeId, c.params.itemId, c.query))
  .add('POST', '/api/v1/spa/types/:typeId/items/:itemId/relations', 'SpaRelationsController', c => relations.link(c.actor, c.params.typeId, c.params.itemId, c.body), 201)
  .add('DELETE', '/api/v1/spa/types/:typeId/items/:itemId/relations/:relationId', 'SpaRelationsController', c => relations.unlink(c.actor, c.params.typeId, c.params.itemId, c.params.relationId))
  .add('GET', '/api/v1/spa/types/:typeId/layouts', 'SpaLayoutsController', c => relations.layouts(c.actor, c.params.typeId, c.query))
  .add('PUT', '/api/v1/spa/types/:typeId/layouts/:layoutId', 'SpaLayoutsController', c => relations.updateLayout(c.actor, c.params.typeId, c.params.layoutId, c.body))
  .add('GET', '/api/v1/spa/types/:typeId/views', 'SpaLayoutsController', c => relations.views(c.actor, c.params.typeId))
  .add('PUT', '/api/v1/spa/types/:typeId/views/me', 'SpaLayoutsController', c => relations.saveView(c.actor, c.params.typeId, c.body))
  .add('POST', '/api/v1/spa/types/:typeId/imports', 'SpaTransfersController', c => transfers.queueImport(c.actor, c.params.typeId, c.body), 202)
  .add('GET', '/api/v1/spa/types/:typeId/imports/:jobId', 'SpaTransfersController', c => transfers.importStatus(c.actor, c.params.typeId, c.params.jobId))
  .add('POST', '/api/v1/spa/types/:typeId/imports/:jobId/cancel', 'SpaTransfersController', c => transfers.cancelImport(c.actor, c.params.typeId, c.params.jobId, c.body))
  .add('POST', '/api/v1/spa/types/:typeId/exports', 'SpaTransfersController', c => transfers.queueExport(c.actor, c.params.typeId, c.body), 202)
  .add('GET', '/api/v1/spa/types/:typeId/exports/:jobId', 'SpaTransfersController', c => transfers.exportStatus(c.actor, c.params.typeId, c.params.jobId))
  .add('GET', '/api/v1/spa/types/:typeId/trash', 'SpaRecycleController', c => transfers.trash(c.actor, c.params.typeId, c.query))
  .add('POST', '/api/v1/spa/types/:typeId/items/:itemId/purge', 'SpaRecycleController', c => transfers.queuePurge(c.actor, c.params.typeId, c.params.itemId, c.body), 202);
