import { CollabRouter, listed } from '../http';
import type { TasksProjectsModule } from './index';

/** REST surface of Tasks & Projects. Paths are relative to /api/v1. */
export function tasksProjectsRoutes(router: CollabRouter, module: () => TasksProjectsModule) {
  const m = module;

  // ---- ProjectsController -------------------------------------------------------------------------------------------
  router
    .post('projects', (c) => m().projects.create(c.actor, c.body))
    .get('projects', (c) => listed(m().projects.list(c.actor, c.query)))
    .get('projects/:id', (c) => m().projects.get(c.actor, c.params.id))
    .put('projects/:id', (c) => m().projects.update(c.actor, c.params.id, c.body, true, c.ifMatch))
    .patch('projects/:id', (c) => m().projects.update(c.actor, c.params.id, c.body, false, c.ifMatch))
    .delete('projects/:id', (c) => m().projects.softDelete(c.actor, c.params.id))
    .patch('projects/:id/restore', (c) => m().projects.restore(c.actor, c.params.id))
    .delete('projects/:id/hard', (c) => m().projects.hardDelete(c.actor, c.params.id))
    .post('projects/:id/archive', (c) => m().projects.archive(c.actor, c.params.id))
    .post('projects/:id/unarchive', (c) => m().projects.unarchive(c.actor, c.params.id))
    .get('projects/:id/tools', (c) => m().projects.listTools(c.actor, c.params.id))
    .put('projects/:id/tools', (c) => m().projects.replaceTools(c.actor, c.params.id, c.body))
    .post('projects/:id/tools/:tool/enable', (c) => m().projects.enableTool(c.actor, c.params.id, c.params.tool, true))
    .post('projects/:id/tools/:tool/disable', (c) => m().projects.enableTool(c.actor, c.params.id, c.params.tool, false))
    .get('projects/:id/linked-resources', (c) => m().projects.linkedResources(c.actor, c.params.id));

  // ---- ProjectMembersController -------------------------------------------------------------------------------------
  router
    .get('projects/:projectId/members', (c) => listed(m().projects.listMembers(c.actor, c.params.projectId, c.query)))
    .post('projects/:projectId/members', (c) => m().projects.addMember(c.actor, c.params.projectId, c.body))
    .get('projects/:projectId/members/:userId', (c) => m().projects.getMember(c.actor, c.params.projectId, c.params.userId))
    .patch('projects/:projectId/members/:userId', (c) => m().projects.updateMember(c.actor, c.params.projectId, c.params.userId, c.body, c.ifMatch))
    .delete('projects/:projectId/members/:userId', (c) => m().projects.removeMember(c.actor, c.params.projectId, c.params.userId))
    .post('projects/:projectId/transfer-ownership', (c) => m().projects.transferOwnership(c.actor, c.params.projectId, c.body))
    .get('projects/:projectId/permissions/effective', (c) => m().projects.effectivePermissions(c.actor, c.params.projectId, c.query));

  // ---- ProjectStagesController --------------------------------------------------------------------------------------
  router
    .get('projects/:projectId/stages', (c) => m().stages.list(c.actor, c.params.projectId))
    .post('projects/:projectId/stages', (c) => m().stages.create(c.actor, c.params.projectId, c.body))
    .patch('projects/:projectId/stages/reorder', (c) => m().stages.reorder(c.actor, c.params.projectId, c.body))
    .get('project-stages/:id', (c) => m().stages.get(c.actor, c.params.id))
    .patch('project-stages/:id', (c) => m().stages.update(c.actor, c.params.id, c.body, c.ifMatch))
    .delete('project-stages/:id', (c) => m().stages.remove(c.actor, c.params.id, c.query, c.body))
    .post('tasks/:taskId/project-stage', (c) => m().stages.moveTask(c.actor, c.params.taskId, c.body, c.ifMatch))
    .get('tasks/:taskId/project-stage-history', (c) => m().stages.stageHistory(c.actor, c.params.taskId))
    .get('tasks/planner', (c) => listed(m().stages.planner(c.actor, c.query)))
    .put('tasks/:taskId/planner-position', (c) => m().stages.setPlannerPosition(c.actor, c.params.taskId, c.body));

  // ---- TasksController ----------------------------------------------------------------------------------------------
  router
    .post('tasks', (c) => m().tasks.createFromRequest(c.actor, c.body, c.idempotencyKey))
    .get('tasks', (c) => listed(m().tasks.list(c.actor, c.query)))
    .get('tasks/:id', (c) => m().tasks.get(c.actor, c.params.id))
    .put('tasks/:id', (c) => m().tasks.update(c.actor, c.params.id, c.body, true, c.ifMatch))
    .patch('tasks/:id', (c) => m().tasks.update(c.actor, c.params.id, c.body, false, c.ifMatch))
    .delete('tasks/:id', (c) => m().tasks.softDelete(c.actor, c.params.id))
    .patch('tasks/:id/restore', (c) => m().tasks.restore(c.actor, c.params.id))
    .delete('tasks/:id/hard', (c) => m().tasks.hardDelete(c.actor, c.params.id))
    .post('tasks/:id/start', (c) => m().tasks.start(c.actor, c.params.id, c.body, c.ifMatch))
    .post('tasks/:id/defer', (c) => m().tasks.defer(c.actor, c.params.id, c.body, c.ifMatch))
    .post('tasks/:id/cancel', (c) => m().tasks.cancel(c.actor, c.params.id, c.body, c.ifMatch))
    .post('tasks/:id/complete', (c) => m().tasks.complete(c.actor, c.params.id, c.body, c.ifMatch))
    .post('tasks/:id/reopen', (c) => m().tasks.reopen(c.actor, c.params.id, c.body, c.ifMatch))
    .post('tasks/:id/completion-review/approve', (c) => m().tasks.review(c.actor, c.params.id, c.body, 'APPROVED', c.ifMatch))
    .post('tasks/:id/completion-review/return', (c) => m().tasks.review(c.actor, c.params.id, c.body, 'RETURNED', c.ifMatch))
    .get('tasks/:id/members', (c) => m().tasks.members(c.actor, c.params.id))
    .post('tasks/:id/participants', (c) => m().tasks.addMember(c.actor, c.params.id, c.body, 'PARTICIPANT'))
    .delete('tasks/:id/participants/:userId', (c) => m().tasks.removeMember(c.actor, c.params.id, c.params.userId, 'PARTICIPANT'))
    .post('tasks/:id/observers', (c) => m().tasks.addMember(c.actor, c.params.id, c.body, 'OBSERVER'))
    .delete('tasks/:id/observers/:userId', (c) => m().tasks.removeMember(c.actor, c.params.id, c.params.userId, 'OBSERVER'))
    .patch('tasks/:id/responsible', (c) => m().tasks.changeResponsible(c.actor, c.params.id, c.body, c.ifMatch))
    .get('tasks/:id/results', (c) => m().tasks.results(c.actor, c.params.id))
    .post('tasks/:id/results', (c) => m().tasks.addResult(c.actor, c.params.id, c.body))
    .get('tasks/:id/history', (c) => listed(m().tasks.historyList(c.actor, c.params.id, c.query)))
    .get('tasks/:id/deadline-history', (c) => m().tasks.deadlineHistory(c.actor, c.params.id))
    .patch('tasks/:id/deadline', (c) => m().tasks.changeDeadline(c.actor, c.params.id, c.body, c.ifMatch))
    .get('tasks/:id/subtasks', (c) => listed(m().tasks.subtasks(c.actor, c.params.id, c.query)))
    .post('tasks/:id/subtasks', (c) => m().tasks.createSubtask(c.actor, c.params.id, c.body, c.idempotencyKey))
    .get('tasks/:id/bindings', (c) => m().tasks.bindings(c.actor, c.params.id))
    .post('tasks/:id/bindings', (c) => m().tasks.addBinding(c.actor, c.params.id, c.body))
    .delete('tasks/:id/bindings/:bindingId', (c) => m().tasks.removeBinding(c.actor, c.params.id, c.params.bindingId));

  // ---- TaskChecklistsController -------------------------------------------------------------------------------------
  router
    .get('tasks/:taskId/checklists', (c) => m().checklists.list(c.actor, c.params.taskId))
    .post('tasks/:taskId/checklists', (c) => m().checklists.create(c.actor, c.params.taskId, c.body))
    .get('task-checklists/:id', (c) => m().checklists.get(c.actor, c.params.id))
    .patch('task-checklists/:id', (c) => m().checklists.update(c.actor, c.params.id, c.body, c.ifMatch))
    .delete('task-checklists/:id', (c) => m().checklists.remove(c.actor, c.params.id))
    .post('task-checklists/:id/items', (c) => m().checklists.addItem(c.actor, c.params.id, c.body))
    .patch('task-checklist-items/:id', (c) => m().checklists.updateItem(c.actor, c.params.id, c.body, c.ifMatch))
    .delete('task-checklist-items/:id', (c) => m().checklists.removeItem(c.actor, c.params.id, c.query))
    .patch('task-checklist-items/:id/move', (c) => m().checklists.moveItem(c.actor, c.params.id, c.body, c.ifMatch))
    .post('task-checklist-items/:id/complete', (c) => m().checklists.setCompleted(c.actor, c.params.id, true, c.body))
    .post('task-checklist-items/:id/reopen', (c) => m().checklists.setCompleted(c.actor, c.params.id, false, c.body));

  // ---- TaskDependenciesController -----------------------------------------------------------------------------------
  router
    .get('tasks/:taskId/dependencies', (c) => m().dependencies.list(c.actor, c.params.taskId))
    .post('tasks/:taskId/dependencies', (c) => m().dependencies.add(c.actor, c.params.taskId, c.body))
    .delete('tasks/:taskId/dependencies/:dependencyId', (c) => m().dependencies.remove(c.actor, c.params.taskId, c.params.dependencyId))
    .get('tasks/:taskId/dependency-graph', (c) => m().dependencies.graph(c.actor, c.params.taskId));

  // ---- TaskTimeEntriesController ------------------------------------------------------------------------------------
  router
    .get('tasks/:taskId/time-entries', (c) => listed(m().time.list(c.actor, c.params.taskId, c.query)))
    .post('tasks/:taskId/time-entries', (c) => m().time.addManual(c.actor, c.params.taskId, c.body))
    .get('task-time-entries/:id', (c) => m().time.get(c.actor, c.params.id))
    .patch('task-time-entries/:id', (c) => m().time.update(c.actor, c.params.id, c.body, c.ifMatch))
    .delete('task-time-entries/:id', (c) => m().time.remove(c.actor, c.params.id))
    .post('tasks/:taskId/timer/start', (c) => m().time.startTimer(c.actor, c.params.taskId))
    .post('tasks/:taskId/timer/stop', (c) => m().time.stopTimer(c.actor, c.params.taskId))
    .get('tasks/:taskId/time-summary', (c) => m().time.summary(c.actor, c.params.taskId));

  // ---- TaskTemplatesController --------------------------------------------------------------------------------------
  router
    .post('task-templates', (c) => m().templates.create(c.actor, c.body))
    .get('task-templates', (c) => listed(m().templates.list(c.actor, c.query)))
    .get('task-templates/:id', (c) => m().templates.get(c.actor, c.params.id))
    .put('task-templates/:id', (c) => m().templates.update(c.actor, c.params.id, c.body, true, c.ifMatch))
    .patch('task-templates/:id', (c) => m().templates.update(c.actor, c.params.id, c.body, false, c.ifMatch))
    .delete('task-templates/:id', (c) => m().templates.remove(c.actor, c.params.id))
    .post('task-templates/:id/instantiate', (c) => m().templates.instantiate(c.actor, c.params.id, c.body, c.idempotencyKey))
    .get('task-templates/:id/recurrence', (c) => m().templates.getRecurrence(c.actor, c.params.id))
    .put('task-templates/:id/recurrence', (c) => m().templates.setRecurrence(c.actor, c.params.id, c.body, true, c.ifMatch))
    .patch('task-templates/:id/recurrence', (c) => m().templates.setRecurrence(c.actor, c.params.id, c.body, false, c.ifMatch))
    .delete('task-templates/:id/recurrence', (c) => m().templates.deleteRecurrence(c.actor, c.params.id))
    .post('task-templates/:id/recurrence/run-due-preview', (c) => m().templates.runDuePreview(c.actor, c.params.id, c.body));

  return router;
}
