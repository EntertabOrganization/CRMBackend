import type { ActorContext } from '../../access-service';
import { AppError, forbidden } from '../../errors';
import type { Body, CollabSupport } from '../support';
import { notFoundError, pageOf, validationError } from '../support';
import type { TasksPolicy } from './policy';
import type { ProjectResourceProvisioner } from './ports';
import type { Project, ProjectMember, ProjectRole, ProjectStage, ProjectStatus, ProjectTool, ProjectToolType } from './types';
import { PROJECT_STATUSES, PROJECT_TOOL_TYPES, PROJECT_TYPES, PROJECT_VISIBILITIES } from './types';

const DEFAULT_TOOLS: ProjectToolType[] = ['TASKS', 'KANBAN'];
const LINKABLE_TOOLS = ['CHAT', 'CALENDAR', 'DRIVE'] as const;
const DEFAULT_STAGES = [
  { name: 'New', code: 'NEW', isDefault: true, isTerminalVisualStage: false },
  { name: 'In progress', code: 'IN_PROGRESS', isDefault: false, isTerminalVisualStage: false },
  { name: 'Done', code: 'DONE', isDefault: false, isTerminalVisualStage: true },
];
const EDITABLE_STATUSES = PROJECT_STATUSES.filter((status) => status !== 'ARCHIVED');

export class ProjectService {
  private readonly provisioners = new Map<string, ProjectResourceProvisioner>();
  /** Set by the Tasks module: invoked after Project membership changes so Task access is re-derived where needed. */
  onProjectMembersChanged: ((project: Project) => void) | null = null;

  constructor(private readonly support: CollabSupport, private readonly policy: TasksPolicy) {}

  private get state() {
    return this.support.state;
  }

  registerProvisioner(provisioner: ProjectResourceProvisioner) {
    this.provisioners.set(provisioner.toolType, provisioner);
  }

  view(actor: ActorContext, project: Project) {
    return {
      ...project,
      myRole: this.policy.projectRole(project, actor.user.id),
      enabledTools: this.state.projectTools.filter((row) => row.projectId === project.id && row.isEnabled).map((row) => row.toolType),
    };
  }

  private event(actor: ActorContext | null, project: Project, type: string, changes: Record<string, unknown> = {}) {
    this.support.event({
      workspaceId: project.workspaceId,
      type,
      entityType: 'PROJECT',
      entityId: project.id,
      actorUserId: actor?.user.id ?? null,
      changes,
      audienceUserIds: this.activeMemberIds(project),
    });
  }

  activeMemberIds(project: Project) {
    const ids = new Set<string>([project.ownerUserId]);
    for (const row of this.state.projectMembers) if (row.projectId === project.id && row.status === 'ACTIVE') ids.add(row.userId);
    return [...ids];
  }

  // ---- CRUD ---------------------------------------------------------------------------------------------------------

  private readCommonFields(body: Body, required: boolean) {
    const name = body.str('name', { required, max: 200 });
    const code = body.str('code', { max: 50 });
    if (code !== undefined && code !== null && !/^[A-Za-z0-9_-]+$/.test(code)) throw validationError('code', 'code may contain letters, digits, "_" and "-" only.');
    return {
      name,
      code,
      description: body.str('description', { max: 10_000 }),
      projectType: body.enumOf('projectType', PROJECT_TYPES),
      status: body.enumOf('status', EDITABLE_STATUSES),
      startDate: body.date('startDate'),
      endDate: body.date('endDate'),
      visibility: body.enumOf('visibility', PROJECT_VISIBILITIES),
    };
  }

  private assertCodeFree(workspaceId: string, code: string | null | undefined, exceptId?: string) {
    if (!code) return;
    const taken = this.state.projects.some((row) => row.workspaceId === workspaceId && row.id !== exceptId && row.code?.toLowerCase() === code.toLowerCase());
    if (taken) throw new AppError('PROJECT_CODE_CONFLICT', 'Another Project already uses this code.', 409);
  }

  private assertDates(projectType: string, startDate: string | null, endDate: string | null) {
    if (startDate && endDate && endDate < startDate) throw validationError('endDate', 'endDate must not be before startDate.');
    if (projectType === 'WORKGROUP' && endDate) throw validationError('endDate', 'A Workgroup is an ongoing container and has no end date.');
  }

  create(actor: ActorContext, body: Body) {
    this.support.require(actor, 'project.create');
    body.only(['name', 'code', 'description', 'projectType', 'status', 'ownerUserId', 'startDate', 'endDate', 'visibility', 'memberUserIds', 'tools']);
    const fields = this.readCommonFields(body, true);
    const ownerUserId = body.uuid('ownerUserId') ?? actor.user.id;
    if (!this.support.isEligibleUser(actor.workspaceId, ownerUserId)) throw new AppError('PROJECT_OWNER_INVALID', 'The owner must be an active internal member of this Workspace.', 400);
    const memberUserIds = body.uuids('memberUserIds', { max: 500 }) ?? [];
    for (const userId of memberUserIds) {
      if (!this.support.isEligibleUser(actor.workspaceId, userId)) throw new AppError('PROJECT_EXTERNAL_MEMBER_NOT_ALLOWED', 'Only active internal Workspace members can join a Project.', 400, { userId });
    }
    const toolsRaw = body.array('tools', { max: PROJECT_TOOL_TYPES.length });
    const tools = toolsRaw === undefined ? DEFAULT_TOOLS : toolsRaw.map((item, index) => {
      if (typeof item !== 'string' || !PROJECT_TOOL_TYPES.includes(item as ProjectToolType)) throw validationError(`tools[${index}]`, `Unsupported tool ${String(item)}.`);
      return item as ProjectToolType;
    });
    const projectType = fields.projectType ?? 'PROJECT';
    this.assertDates(projectType, fields.startDate ?? null, fields.endDate ?? null);
    this.assertCodeFree(actor.workspaceId, fields.code);
    const now = this.support.now();
    const project: Project = {
      id: this.support.id(),
      workspaceId: actor.workspaceId,
      name: fields.name!,
      code: fields.code ?? null,
      description: fields.description ?? null,
      projectType,
      status: fields.status ?? 'ACTIVE',
      statusBeforeArchive: null,
      ownerUserId,
      startDate: fields.startDate ?? null,
      endDate: fields.endDate ?? null,
      visibility: fields.visibility ?? 'PRIVATE',
      createdByUserId: actor.user.id,
      version: 1,
      isDeleted: false,
      deletedAt: null,
      deletedByUserId: null,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.state.projects.push(project);
    this.addMemberRow(project, ownerUserId, 'OWNER', actor.user.id);
    for (const userId of memberUserIds) if (userId !== ownerUserId) this.addMemberRow(project, userId, 'MEMBER', actor.user.id);
    for (const toolType of PROJECT_TOOL_TYPES) {
      this.state.projectTools.push({
        id: this.support.id(), workspaceId: project.workspaceId, projectId: project.id, toolType, isEnabled: tools.includes(toolType),
        configurationJson: {}, linkedResourceType: null, linkedResourceId: null, version: 1, createdAt: now, updatedAt: now,
      });
    }
    if (tools.includes('KANBAN')) this.ensureDefaultStages(project);
    this.event(actor, project, 'PROJECT_CREATED', { name: project.name, projectType: project.projectType });
    this.support.audit(actor, project.workspaceId, 'PROJECT.CREATED', 'PROJECT', project.id, null, { name: project.name, ownerUserId, visibility: project.visibility });
    return this.view(actor, project);
  }

  list(actor: ActorContext, query: URLSearchParams) {
    this.support.require(actor, 'project.read');
    const deleted = query.get('deleted') === 'true';
    if (deleted) this.support.require(actor, 'project.delete');
    const mine = query.get('mine') === 'true';
    const rows = this.state.projects.filter(
      (row) => row.workspaceId === actor.workspaceId && row.isDeleted === deleted && this.policy.canViewProject(actor, row) && (!mine || this.policy.projectRole(row, actor.user.id) !== null),
    );
    const page = pageOf(rows, query, {
      searchable: ['name', 'code', 'description'],
      filterable: ['status', 'projectType', 'visibility', 'ownerUserId'],
      sortable: ['name', 'createdAt', 'updatedAt', 'startDate', 'endDate', 'status'],
      defaultSort: 'createdAt',
      defaultOrder: 'desc',
    });
    return { data: page.data.map((row) => this.view(actor, row)), meta: page.meta };
  }

  get(actor: ActorContext, id: string) {
    return this.view(actor, this.policy.project(actor, id));
  }

  update(actor: ActorContext, id: string, body: Body, replace: boolean, ifMatch?: number) {
    const project = this.policy.project(actor, id);
    this.policy.requireManageProject(actor, project, 'project.update');
    this.policy.assertNotArchived(project);
    body.only(['name', 'code', 'description', 'projectType', 'status', 'startDate', 'endDate', 'visibility', 'version']);
    this.support.expectVersion(project, body.raw.version ?? ifMatch);
    const fields = this.readCommonFields(body, replace);
    if (replace) {
      for (const key of ['projectType', 'status', 'visibility'] as const) if (!fields[key]) throw validationError(key, `${key} is required for PUT.`);
    }
    const before = { ...project };
    const next = {
      name: fields.name ?? project.name,
      code: replace ? fields.code ?? null : fields.code === undefined ? project.code : fields.code,
      description: replace ? fields.description ?? null : fields.description === undefined ? project.description : fields.description,
      projectType: fields.projectType ?? project.projectType,
      status: (fields.status ?? project.status) as ProjectStatus,
      startDate: replace ? fields.startDate ?? null : fields.startDate === undefined ? project.startDate : fields.startDate,
      endDate: replace ? fields.endDate ?? null : fields.endDate === undefined ? project.endDate : fields.endDate,
      visibility: fields.visibility ?? project.visibility,
    };
    this.assertDates(next.projectType, next.startDate, next.endDate);
    this.assertCodeFree(project.workspaceId, next.code, project.id);
    Object.assign(project, next);
    this.support.touch(project);
    const changed = Object.keys(next).filter((key) => JSON.stringify(before[key as keyof Project]) !== JSON.stringify(project[key as keyof Project]));
    this.event(actor, project, 'PROJECT_UPDATED', { changedFields: changed });
    return this.view(actor, project);
  }

  softDelete(actor: ActorContext, id: string) {
    const project = this.policy.project(actor, id);
    this.policy.requireManageProject(actor, project, 'project.delete');
    project.isDeleted = true;
    project.deletedAt = this.support.now();
    project.deletedByUserId = actor.user.id;
    this.support.touch(project);
    this.event(actor, project, 'PROJECT_DELETED', { hard: false });
    this.support.audit(actor, project.workspaceId, 'PROJECT.SOFT_DELETED', 'PROJECT', project.id, null, { name: project.name });
    return this.view(actor, project);
  }

  restore(actor: ActorContext, id: string) {
    const project = this.policy.project(actor, id, { includeDeleted: true });
    this.policy.requireManageProject(actor, project, 'project.delete');
    if (!project.isDeleted) throw new AppError('PROJECT_NOT_DELETED', 'The Project is not deleted.', 409);
    project.isDeleted = false;
    project.deletedAt = null;
    project.deletedByUserId = null;
    this.support.touch(project);
    this.event(actor, project, 'PROJECT_RESTORED');
    this.support.audit(actor, project.workspaceId, 'PROJECT.RESTORED', 'PROJECT', project.id, null, { name: project.name });
    return this.view(actor, project);
  }

  /**
   * Permanent removal of the Project container. Tasks survive (detached), Templates lose their default Project, and
   * linked Chat/Calendar/Drive keep their own history and lifecycle — only the Project link is removed. Audit remains.
   */
  hardDelete(actor: ActorContext, id: string) {
    const project = this.policy.project(actor, id, { includeDeleted: true });
    this.support.require(actor, 'project.hard_delete');
    if (!this.policy.canManageProject(actor, project, 'project.hard_delete')) throw forbidden('project.hard_delete requires a managing role in this Project.');
    if (!project.isDeleted) throw new AppError('PROJECT_NOT_DELETED', 'Soft delete the Project before deleting it permanently.', 409);
    const s = this.state;
    for (const tool of s.projectTools.filter((row) => row.projectId === project.id && row.linkedResourceId)) {
      this.provisioners.get(tool.toolType)?.detach(project, tool.linkedResourceId!);
    }
    const now = this.support.now();
    for (const task of s.tasks.filter((row) => row.projectId === project.id)) {
      task.projectId = null;
      task.projectStageId = null;
      this.support.touch(task);
      s.taskHistory.push({ id: this.support.id(), workspaceId: task.workspaceId, taskId: task.id, action: 'PROJECT_DETACHED', field: 'projectId', oldValue: project.id, newValue: null, actorUserId: actor.user.id, occurredAt: now });
    }
    for (const template of s.taskTemplates.filter((row) => row.projectId === project.id)) {
      template.projectId = null;
      this.support.touch(template);
    }
    s.projectStages = s.projectStages.filter((row) => row.projectId !== project.id);
    s.projectTools = s.projectTools.filter((row) => row.projectId !== project.id);
    s.projectMembers = s.projectMembers.filter((row) => row.projectId !== project.id);
    s.projects = s.projects.filter((row) => row.id !== project.id);
    this.support.event({ workspaceId: project.workspaceId, type: 'PROJECT_DELETED', entityType: 'PROJECT', entityId: project.id, actorUserId: actor.user.id, changes: { hard: true } });
    this.support.audit(actor, project.workspaceId, 'PROJECT.HARD_DELETED', 'PROJECT', project.id, { name: project.name, code: project.code }, null);
    return { id: project.id, deleted: true };
  }

  archive(actor: ActorContext, id: string) {
    const project = this.policy.project(actor, id);
    this.policy.requireManageProject(actor, project, 'project.archive');
    this.policy.assertNotArchived(project);
    project.statusBeforeArchive = project.status;
    project.status = 'ARCHIVED';
    project.archivedAt = this.support.now();
    this.support.touch(project);
    this.setLinkedReadOnly(project, true);
    this.event(actor, project, 'PROJECT_ARCHIVED');
    this.support.audit(actor, project.workspaceId, 'PROJECT.ARCHIVED', 'PROJECT', project.id, { status: project.statusBeforeArchive }, { status: 'ARCHIVED' });
    return this.view(actor, project);
  }

  unarchive(actor: ActorContext, id: string) {
    const project = this.policy.project(actor, id);
    this.policy.requireManageProject(actor, project, 'project.archive');
    if (project.status !== 'ARCHIVED') throw new AppError('PROJECT_NOT_ARCHIVED', 'The Project is not archived.', 409);
    project.status = project.statusBeforeArchive ?? 'ACTIVE';
    project.statusBeforeArchive = null;
    project.archivedAt = null;
    this.support.touch(project);
    this.setLinkedReadOnly(project, false);
    this.event(actor, project, 'PROJECT_UNARCHIVED');
    this.support.audit(actor, project.workspaceId, 'PROJECT.UNARCHIVED', 'PROJECT', project.id, { status: 'ARCHIVED' }, { status: project.status });
    return this.view(actor, project);
  }

  private setLinkedReadOnly(project: Project, readOnly: boolean) {
    for (const tool of this.state.projectTools.filter((row) => row.projectId === project.id && row.linkedResourceId)) {
      this.provisioners.get(tool.toolType)?.setReadOnly(project, tool.linkedResourceId!, readOnly);
    }
  }

  // ---- tools & linked resources --------------------------------------------------------------------------------------

  private toolRow(project: Project, toolType: ProjectToolType): ProjectTool {
    let row = this.state.projectTools.find((item) => item.projectId === project.id && item.toolType === toolType);
    if (!row) {
      const now = this.support.now();
      row = { id: this.support.id(), workspaceId: project.workspaceId, projectId: project.id, toolType, isEnabled: false, configurationJson: {}, linkedResourceType: null, linkedResourceId: null, version: 1, createdAt: now, updatedAt: now };
      this.state.projectTools.push(row);
    }
    return row;
  }

  listTools(actor: ActorContext, id: string) {
    const project = this.policy.project(actor, id);
    return PROJECT_TOOL_TYPES.map((toolType) => this.state.projectTools.find((row) => row.projectId === project.id && row.toolType === toolType)
      ?? { projectId: project.id, toolType, isEnabled: false, configurationJson: {}, linkedResourceType: null, linkedResourceId: null, version: 0 });
  }

  private parseTool(raw: string): ProjectToolType {
    const toolType = raw.toUpperCase() as ProjectToolType;
    if (!PROJECT_TOOL_TYPES.includes(toolType)) throw validationError('tool', `Unsupported tool ${raw}.`);
    return toolType;
  }

  /**
   * Provisions the canonical linked resource through the owning module. A retry (or a second enable) finds the stored
   * link and returns the same resource; the owning module is idempotent on the Project id as a second guard.
   */
  private provision(actor: ActorContext, project: Project, tool: ProjectTool) {
    if (!(LINKABLE_TOOLS as readonly string[]).includes(tool.toolType)) return null;
    if (tool.linkedResourceId) return tool.linkedResourceId;
    const provisioner = this.provisioners.get(tool.toolType);
    if (!provisioner) throw new AppError('PROJECT_LINKED_RESOURCE_PROVISION_FAILED', `${tool.toolType} provisioning is not available.`, 503, { toolType: tool.toolType });
    let resourceId: string;
    try {
      resourceId = provisioner.provision(project, actor.user.id, this.activeMemberIds(project));
    } catch (error) {
      if (error instanceof AppError || (error as { isAppError?: boolean })?.isAppError) throw error;
      throw new AppError('PROJECT_LINKED_RESOURCE_PROVISION_FAILED', `${tool.toolType} could not be provisioned.`, 503, { toolType: tool.toolType });
    }
    tool.linkedResourceType = provisioner.resourceType;
    tool.linkedResourceId = resourceId;
    this.support.touch(tool);
    return resourceId;
  }

  private setTool(actor: ActorContext, project: Project, toolType: ProjectToolType, isEnabled: boolean, configuration?: Record<string, unknown>) {
    const tool = this.toolRow(project, toolType);
    const before = { isEnabled: tool.isEnabled, configurationJson: tool.configurationJson };
    const changed = tool.isEnabled !== isEnabled || (configuration !== undefined && JSON.stringify(configuration) !== JSON.stringify(tool.configurationJson));
    if (changed) {
      tool.isEnabled = isEnabled;
      if (configuration !== undefined) tool.configurationJson = configuration;
      this.support.touch(tool);
    }
    if (isEnabled && toolType === 'KANBAN') this.ensureDefaultStages(project);
    if (isEnabled) this.provision(actor, project, tool);
    if (changed) {
      this.event(actor, project, isEnabled ? 'PROJECT_TOOL_ENABLED' : 'PROJECT_TOOL_DISABLED', { toolType });
      this.support.audit(actor, project.workspaceId, 'PROJECT.TOOL_CHANGED', 'PROJECT', project.id, { toolType, ...before }, { toolType, isEnabled, configurationJson: tool.configurationJson });
    }
    return tool;
  }

  enableTool(actor: ActorContext, id: string, rawTool: string, enable: boolean) {
    const project = this.policy.project(actor, id);
    this.policy.requireManageProject(actor, project, 'project.tool_manage');
    this.policy.assertNotArchived(project);
    return this.setTool(actor, project, this.parseTool(rawTool), enable);
  }

  replaceTools(actor: ActorContext, id: string, body: Body) {
    const project = this.policy.project(actor, id);
    this.policy.requireManageProject(actor, project, 'project.tool_manage');
    this.policy.assertNotArchived(project);
    body.only(['tools']);
    const items = body.array('tools', { required: true, max: PROJECT_TOOL_TYPES.length })!;
    const parsed = items.map((item, index) => {
      if (!item || typeof item !== 'object') throw validationError(`tools[${index}]`, 'Each tool must be an object.');
      const entry = item as Record<string, unknown>;
      const toolType = this.parseTool(String(entry.toolType ?? ''));
      if (typeof entry.isEnabled !== 'boolean') throw validationError(`tools[${index}].isEnabled`, 'isEnabled is required.');
      const configuration = entry.configurationJson;
      if (configuration !== undefined && (configuration === null || typeof configuration !== 'object' || Array.isArray(configuration))) throw validationError(`tools[${index}].configurationJson`, 'configurationJson must be an object.');
      const version = entry.version;
      return { toolType, isEnabled: entry.isEnabled, configuration: (configuration ?? {}) as Record<string, unknown>, version };
    });
    if (new Set(parsed.map((item) => item.toolType)).size !== parsed.length) throw validationError('tools', 'Each tool may appear only once.');
    if (parsed.length !== PROJECT_TOOL_TYPES.length) throw validationError('tools', 'PUT replaces the complete tool configuration: every tool type must be listed.');
    for (const item of parsed) {
      const existing = this.state.projectTools.find((row) => row.projectId === project.id && row.toolType === item.toolType);
      if (existing && item.version !== undefined) this.support.expectVersion(existing, item.version);
    }
    for (const item of parsed) this.setTool(actor, project, item.toolType, item.isEnabled, item.configuration);
    return this.listTools(actor, id);
  }

  linkedResources(actor: ActorContext, id: string) {
    const project = this.policy.project(actor, id);
    const result: Record<string, { toolType: string; isEnabled: boolean; resourceType: string | null; resourceId: string | null }> = {};
    for (const toolType of LINKABLE_TOOLS) {
      const tool = this.state.projectTools.find((row) => row.projectId === project.id && row.toolType === toolType);
      // Lazy provisioning on first access of an enabled tool (never for archived Projects, which are read-only).
      if (tool?.isEnabled && !tool.linkedResourceId && project.status !== 'ARCHIVED') this.provision(actor, project, tool);
      result[toolType] = { toolType, isEnabled: tool?.isEnabled ?? false, resourceType: tool?.linkedResourceType ?? null, resourceId: tool?.linkedResourceId ?? null };
    }
    return result;
  }

  // ---- stages bootstrap ---------------------------------------------------------------------------------------------

  ensureDefaultStages(project: Project): ProjectStage[] {
    const live = this.state.projectStages.filter((row) => row.projectId === project.id && !row.isDeleted);
    if (live.length > 0) return live;
    const now = this.support.now();
    const created = DEFAULT_STAGES.map((stage, index) => ({
      id: this.support.id(), workspaceId: project.workspaceId, projectId: project.id, name: stage.name, code: stage.code, sortOrder: (index + 1) * 100,
      isDefault: stage.isDefault, isTerminalVisualStage: stage.isTerminalVisualStage, version: 1, isDeleted: false, createdAt: now, updatedAt: now,
    }));
    this.state.projectStages.push(...created);
    const defaultStage = created[0];
    for (const task of this.state.tasks.filter((row) => row.projectId === project.id && !row.projectStageId)) {
      task.projectStageId = defaultStage.id;
      this.support.touch(task);
      this.state.projectStageHistory.push({ id: this.support.id(), workspaceId: task.workspaceId, taskId: task.id, projectId: project.id, oldStageId: null, newStageId: defaultStage.id, movedByUserId: project.ownerUserId, movedAt: now });
    }
    return created;
  }

  // ---- members ------------------------------------------------------------------------------------------------------

  private addMemberRow(project: Project, userId: string, role: ProjectRole, invitedBy: string) {
    const now = this.support.now();
    const row: ProjectMember = {
      id: this.support.id(), workspaceId: project.workspaceId, projectId: project.id, userId, memberRole: role, status: 'ACTIVE',
      joinedAt: now, leftAt: null, invitedByUserId: invitedBy, version: 1, createdAt: now, updatedAt: now,
    };
    this.state.projectMembers.push(row);
    return row;
  }

  private memberView(row: ProjectMember) {
    const user = this.state.users.find((item) => item.id === row.userId);
    return { ...row, user: user ? { id: user.id, firstName: user.firstName, lastName: user.lastName, email: user.email } : null };
  }

  /** Replaces the PROJECT access source on every provisioned resource; other access sources stay as they are. */
  private syncLinkedMembers(project: Project) {
    const members = this.activeMemberIds(project);
    for (const tool of this.state.projectTools.filter((row) => row.projectId === project.id && row.linkedResourceId)) {
      this.provisioners.get(tool.toolType)?.syncProjectMembers(project, tool.linkedResourceId!, members);
    }
    this.onProjectMembersChanged?.(project);
  }

  private memberChanged(actor: ActorContext, project: Project, userId: string, change: string, before: unknown, after: unknown) {
    this.syncLinkedMembers(project);
    this.event(actor, project, 'PROJECT_MEMBER_CHANGED', { userId, change });
    this.support.audit(actor, project.workspaceId, `PROJECT.MEMBER_${change}`, 'PROJECT', project.id, before, after, { userId });
  }

  listMembers(actor: ActorContext, projectId: string, query: URLSearchParams) {
    const project = this.policy.project(actor, projectId);
    this.support.require(actor, 'project.member_view');
    const status = query.get('status');
    const rows = this.state.projectMembers.filter((row) => row.projectId === project.id && (status ? row.status === status : row.status !== 'REMOVED'));
    const page = pageOf(rows, query, { searchable: [], filterable: ['memberRole'], sortable: ['createdAt', 'memberRole', 'joinedAt'], defaultSort: 'createdAt' });
    return { data: page.data.map((row) => this.memberView(row)), meta: page.meta };
  }

  private memberRow(project: Project, userId: string) {
    const row = this.state.projectMembers.find((item) => item.projectId === project.id && item.userId === userId);
    if (!row) throw notFoundError('PROJECT_MEMBER_NOT_FOUND', 'Project member');
    return row;
  }

  getMember(actor: ActorContext, projectId: string, userId: string) {
    const project = this.policy.project(actor, projectId);
    this.support.require(actor, 'project.member_view');
    return this.memberView(this.memberRow(project, userId));
  }

  addMember(actor: ActorContext, projectId: string, body: Body) {
    const project = this.policy.project(actor, projectId);
    this.policy.assertNotArchived(project);
    body.only(['userId', 'memberRole']);
    const userId = body.uuid('userId', { required: true });
    const role = body.enumOf('memberRole', ['MEMBER', 'MODERATOR'] as const) ?? 'MEMBER';
    const selfJoin = userId === actor.user.id && role === 'MEMBER' && project.visibility === 'OPEN';
    if (!selfJoin) this.policy.requireManageProject(actor, project, 'project.member_manage');
    if (!this.support.isEligibleUser(project.workspaceId, userId)) {
      throw new AppError('PROJECT_EXTERNAL_MEMBER_NOT_ALLOWED', 'Only active internal Workspace members can join a Project. External people collaborate through Collabs.', 400);
    }
    let row = this.state.projectMembers.find((item) => item.projectId === project.id && item.userId === userId);
    if (row?.status === 'ACTIVE') return this.memberView(row);
    const before = row ? { status: row.status, memberRole: row.memberRole } : null;
    if (row) {
      row.status = 'ACTIVE';
      row.memberRole = role;
      row.joinedAt = this.support.now();
      row.leftAt = null;
      row.invitedByUserId = actor.user.id;
      this.support.touch(row);
    } else {
      row = this.addMemberRow(project, userId, role, actor.user.id);
    }
    this.memberChanged(actor, project, userId, 'ADDED', before, { status: 'ACTIVE', memberRole: role });
    return this.memberView(row);
  }

  updateMember(actor: ActorContext, projectId: string, userId: string, body: Body, ifMatch?: number) {
    const project = this.policy.project(actor, projectId);
    this.policy.requireManageProject(actor, project, 'project.member_manage');
    this.policy.assertNotArchived(project);
    body.only(['memberRole', 'version']);
    const row = this.memberRow(project, userId);
    if (row.status !== 'ACTIVE') throw notFoundError('PROJECT_MEMBER_NOT_FOUND', 'Project member');
    this.support.expectVersion(row, body.raw.version ?? ifMatch);
    const role = body.enumOf('memberRole', ['MEMBER', 'MODERATOR'] as const, { required: true });
    if (project.ownerUserId === userId) throw new AppError('PROJECT_OWNER_REQUIRED', 'The owner role changes only through ownership transfer.', 409);
    if (row.memberRole === role) return this.memberView(row);
    const before = { memberRole: row.memberRole };
    row.memberRole = role;
    this.support.touch(row);
    this.memberChanged(actor, project, userId, 'ROLE_CHANGED', before, { memberRole: role });
    return this.memberView(row);
  }

  removeMember(actor: ActorContext, projectId: string, userId: string) {
    const project = this.policy.project(actor, projectId);
    this.policy.assertNotArchived(project);
    const self = userId === actor.user.id;
    if (!self) this.policy.requireManageProject(actor, project, 'project.member_manage');
    const row = this.memberRow(project, userId);
    if (row.status === 'REMOVED') throw notFoundError('PROJECT_MEMBER_NOT_FOUND', 'Project member');
    if (project.ownerUserId === userId) throw new AppError('PROJECT_OWNER_REQUIRED', 'The sole owner cannot be removed. Transfer ownership first.', 409);
    const before = { status: row.status, memberRole: row.memberRole };
    row.status = 'REMOVED';
    row.leftAt = this.support.now();
    this.support.touch(row);
    this.memberChanged(actor, project, userId, 'REMOVED', before, { status: 'REMOVED' });
    return this.memberView(row);
  }

  transferOwnership(actor: ActorContext, projectId: string, body: Body) {
    const project = this.policy.project(actor, projectId);
    this.policy.assertNotArchived(project);
    this.support.require(actor, 'project.owner_transfer');
    const scope = this.support.scope(actor, 'project.owner_transfer');
    if (project.ownerUserId !== actor.user.id && scope !== 'WORKSPACE' && !actor.role.isOwnerRole) throw forbidden('Only the current owner or a workspace administrator can transfer ownership.');
    body.only(['newOwnerUserId', 'version']);
    const newOwnerUserId = body.uuid('newOwnerUserId', { required: true });
    this.support.expectVersion(project, body.raw.version, false);
    if (newOwnerUserId === project.ownerUserId) throw new AppError('PROJECT_OWNER_TRANSFER_INVALID', 'The user already owns this Project.', 400);
    if (!this.support.isEligibleUser(project.workspaceId, newOwnerUserId)) throw new AppError('PROJECT_OWNER_TRANSFER_INVALID', 'The new owner must be an active internal member of this Workspace.', 400);
    const previousOwnerId = project.ownerUserId;
    const previous = this.state.projectMembers.find((row) => row.projectId === project.id && row.userId === previousOwnerId);
    if (previous) {
      previous.memberRole = 'MODERATOR';
      previous.status = 'ACTIVE';
      this.support.touch(previous);
    } else {
      this.addMemberRow(project, previousOwnerId, 'MODERATOR', actor.user.id);
    }
    const next = this.state.projectMembers.find((row) => row.projectId === project.id && row.userId === newOwnerUserId);
    if (next) {
      next.memberRole = 'OWNER';
      next.status = 'ACTIVE';
      next.leftAt = null;
      next.joinedAt = next.joinedAt ?? this.support.now();
      this.support.touch(next);
    } else {
      this.addMemberRow(project, newOwnerUserId, 'OWNER', actor.user.id);
    }
    project.ownerUserId = newOwnerUserId;
    this.support.touch(project);
    this.syncLinkedMembers(project);
    this.event(actor, project, 'PROJECT_OWNER_CHANGED', { previousOwnerUserId: previousOwnerId, ownerUserId: newOwnerUserId });
    this.support.audit(actor, project.workspaceId, 'PROJECT.OWNER_CHANGED', 'PROJECT', project.id, { ownerUserId: previousOwnerId }, { ownerUserId: newOwnerUserId });
    return this.view(actor, project);
  }

  effectivePermissions(actor: ActorContext, projectId: string, query: URLSearchParams) {
    const project = this.policy.project(actor, projectId);
    const targetUserId = query.get('userId');
    if (targetUserId && targetUserId !== actor.user.id) {
      this.support.require(actor, 'project.permission_view');
      if (!this.policy.canManageProject(actor, project, 'project.permission_view')) throw forbidden('project.permission_view requires a managing role in this Project.');
      const user = this.state.users.find((row) => row.id === targetUserId && !row.isDeleted);
      if (!user || !this.support.access.isActiveMember(project.workspaceId, targetUserId)) throw notFoundError('PROJECT_MEMBER_NOT_FOUND', 'Project member');
      return this.capabilities(this.support.access.actor(user, project.workspaceId), project);
    }
    return this.capabilities(actor, project);
  }

  private capabilities(subject: ActorContext, project: Project) {
    const archived = project.status === 'ARCHIVED';
    const manage = (permission: string) => this.policy.canManageProject(subject, project, permission);
    const role = this.policy.projectRole(project, subject.user.id);
    return {
      projectId: project.id,
      userId: subject.user.id,
      projectRole: role,
      archived,
      canView: this.policy.canViewProject(subject, project),
      canJoin: !role && project.visibility === 'OPEN' && !archived,
      canUpdate: !archived && manage('project.update'),
      canDelete: manage('project.delete'),
      canHardDelete: manage('project.hard_delete'),
      canArchive: manage('project.archive'),
      canManageTools: !archived && manage('project.tool_manage'),
      canViewMembers: Boolean(this.support.scope(subject, 'project.member_view')),
      canManageMembers: !archived && manage('project.member_manage'),
      canTransferOwnership: !archived && Boolean(this.support.scope(subject, 'project.owner_transfer')) && (project.ownerUserId === subject.user.id || this.support.scope(subject, 'project.owner_transfer') === 'WORKSPACE' || subject.role.isOwnerRole),
      canManageStages: !archived && manage('project.stage_manage'),
      canMoveTaskStage: !archived && Boolean(this.support.scope(subject, 'project.task_move_stage')) && (role !== null || subject.role.isOwnerRole || this.support.scope(subject, 'project.task_move_stage') === 'WORKSPACE'),
      canCreateTasks: !archived && Boolean(this.support.scope(subject, 'task.create')) && (role !== null || subject.role.isOwnerRole),
    };
  }
}
