import type { ActorContext } from '../../access-service';
import { AppError, forbidden } from '../../errors';
import { Body, isIanaTimezone, isUuid, notFoundError, pageOf, validationError } from '../support';
import type { CollabSupport } from '../support';
import type { ProjectResourceProvisioner } from '../tasks/ports';
import type { ProjectService } from '../tasks/project-service';
import type { TasksPolicy } from '../tasks/policy';
import type { Project } from '../tasks/types';
import { CalendarPolicy } from './policy';
import { CALENDAR_LEVELS, CALENDAR_SUBJECTS, CALENDAR_TYPES } from './types';
import type { Calendar, CalendarPermission, UserCalendarPreference } from './types';

const EDITABLE = ['name', 'description', 'timezone', 'colorPreference', 'isActive'];

export class CalendarService {
  readonly policy: CalendarPolicy;
  constructor(private readonly support: CollabSupport, private readonly projectPolicy: TasksPolicy, private readonly projects: ProjectService) {
    this.policy = new CalendarPolicy(support, projectPolicy);
  }
  private get state() { return this.support.state; }
  private event(calendar: Calendar, type: string, actorUserId: string | null, changes: Record<string, unknown> = {}) {
    this.support.event({ workspaceId: calendar.workspaceId, type, entityType: 'CALENDAR', entityId: calendar.id, actorUserId, changes });
  }
  private timezone(body: Body, required = false) {
    const value = body.str('timezone', { max: 100 });
    if (value === undefined && !required) return undefined;
    if (!isIanaTimezone(value)) throw new AppError('CALENDAR_INVALID_TIMEZONE', 'timezone must be a valid IANA time zone.', 400);
    return value;
  }
  private color(body: Body) {
    const value = body.str('colorPreference', { max: 7 });
    if (value != null && !/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) throw validationError('colorPreference', 'colorPreference must be a hex color.');
    return value;
  }
  private preferencesOf(actor: ActorContext, calendar: Calendar) {
    const row = this.state.userCalendarPreferences.find((p) => p.workspaceId === actor.workspaceId && p.calendarId === calendar.id && p.userId === actor.user.id);
    return row ?? { calendarId: calendar.id, userId: actor.user.id, colorPreference: calendar.colorPreference, isVisible: true, version: 0 };
  }
  view(actor: ActorContext, calendar: Calendar) {
    return { ...calendar, effectiveLevel: this.policy.level(actor, calendar), preferences: this.preferencesOf(actor, calendar) };
  }
  list(actor: ActorContext, query: URLSearchParams) {
    this.support.require(actor, 'calendar.read');
    const rows = this.state.calendars.filter((row) => this.policy.level(actor, row));
    const page = pageOf(rows, query, { searchable: ['name', 'description'], filterable: ['type', 'ownerUserId', 'departmentId', 'projectId', 'isActive'], sortable: ['name', 'createdAt', 'updatedAt'], defaultSort: 'name' });
    return { ...page, data: page.data.map((row) => this.view(actor, row)) };
  }
  get(actor: ActorContext, id: string) { return this.view(actor, this.policy.calendar(actor, id)); }

  create(actor: ActorContext, body: Body) {
    const scope = this.support.require(actor, 'calendar.create');
    body.only([...EDITABLE, 'type', 'ownerUserId', 'departmentId', 'projectId']);
    const type = body.enumOf('type', CALENDAR_TYPES, { required: true });
    const name = body.str('name', { required: true, max: 200 });
    const timezone = this.timezone(body, true)!;
    const departmentId = body.uuid('departmentId') ?? null;
    const projectId = body.uuid('projectId') ?? null;
    const ownerUserId = body.uuid('ownerUserId') ?? (type === 'PERSONAL' || type === 'COMPANY' ? actor.user.id : null);
    if (type !== 'DEPARTMENT' && departmentId || type !== 'PROJECT' && projectId || (type === 'DEPARTMENT' || type === 'PROJECT') && ownerUserId) throw validationError('type', 'Calendar owner and source fields must match its type.');
    if (ownerUserId && !this.support.isEligibleUser(actor.workspaceId, ownerUserId)) throw new AppError('CALENDAR_INVALID_OWNER', 'Calendar owner must be an active internal Workspace member.', 400);
    if (ownerUserId && ownerUserId !== actor.user.id && scope !== 'WORKSPACE') throw forbidden('Creating another user calendar requires workspace scope.');
    if (type === 'COMPANY' && scope !== 'WORKSPACE') throw forbidden('Company Calendar creation requires workspace scope.');
    if (type === 'DEPARTMENT') {
      const department = this.state.departments.find((row) => row.id === departmentId && row.workspaceId === actor.workspaceId && !row.isDeleted);
      if (!department) throw notFoundError('DEPARTMENT_NOT_FOUND', 'Department');
      if (scope !== 'WORKSPACE' && department.managerId !== actor.user.id) throw forbidden('Department Calendar creation requires a department manager or workspace scope.');
    }
    if (type === 'PROJECT') {
      if (!projectId) throw validationError('projectId', 'Project Calendar requires a projectId.');
      const project = this.projectPolicy.project(actor, projectId);
      this.projectPolicy.assertNotArchived(project);
      if (scope !== 'WORKSPACE' && !this.projectPolicy.isProjectManager(project, actor.user.id)) throw forbidden('Project Calendar creation requires a managing Project role.');
      if (this.state.calendars.some((row) => row.projectId === project.id)) throw new AppError('CALENDAR_PROJECT_EXISTS', 'This Project already has a canonical Calendar.', 409);
    }
    const now = this.support.now();
    const calendar: Calendar = {
      id: this.support.id(), workspaceId: actor.workspaceId, type, ownerUserId, departmentId, projectId, createdByUserId: actor.user.id,
      name, timezone, description: body.str('description', { max: 10_000 }) ?? null, colorPreference: this.color(body) ?? null,
      isActive: body.bool('isActive') ?? true, isReadOnly: false, isDeleted: false, version: 1, createdAt: now, updatedAt: now,
    };
    this.state.calendars.push(calendar);
    if (calendar.projectId) this.projects.onCalendarCreated(actor, calendar.projectId, calendar.id);
    this.event(calendar, 'CALENDAR_CREATED', actor.user.id, { type, name });
    return this.view(actor, calendar);
  }

  update(actor: ActorContext, id: string, body: Body, replace: boolean, ifMatch?: number) {
    const calendar = this.policy.calendar(actor, id);
    this.policy.requireLevel(actor, calendar, 'MANAGE', 'calendar.update');
    this.policy.assertWritable(calendar);
    body.only([...EDITABLE, 'type', 'version']);
    this.support.expectVersion(calendar, body.raw.version ?? ifMatch);
    if (body.has('type') && body.enumOf('type', CALENDAR_TYPES) !== calendar.type) throw validationError('type', 'Calendar type cannot be changed.');
    const name = replace || body.has('name') ? body.str('name', { required: true, max: 200 }) : calendar.name;
    const timezone = replace || body.has('timezone') ? this.timezone(body, true)! : calendar.timezone;
    const description = replace || body.has('description') ? body.str('description', { max: 10_000 }) ?? null : calendar.description;
    const colorPreference = replace || body.has('colorPreference') ? this.color(body) ?? null : calendar.colorPreference;
    const isActive = body.bool('isActive') ?? (replace ? true : calendar.isActive);
    Object.assign(calendar, { name, timezone, description, colorPreference, isActive });
    this.support.touch(calendar);
    this.event(calendar, 'CALENDAR_UPDATED', actor.user.id, { version: calendar.version });
    return this.view(actor, calendar);
  }

  remove(actor: ActorContext, id: string) {
    const calendar = this.policy.calendar(actor, id);
    this.policy.requireLevel(actor, calendar, 'MANAGE', 'calendar.delete');
    this.policy.assertWritable(calendar);
    const before = { name: calendar.name, projectId: calendar.projectId };
    if (calendar.projectId) {
      this.projects.onCalendarDeleted(actor, calendar.projectId, calendar.id);
      calendar.projectId = null;
      calendar.ownerUserId = calendar.createdByUserId;
      calendar.isReadOnly = true;
    }
    calendar.isDeleted = true;
    calendar.isActive = false;
    this.support.touch(calendar);
    this.event(calendar, 'CALENDAR_UPDATED', actor.user.id, { deleted: true });
    this.support.audit(actor, calendar.workspaceId, 'CALENDAR.DELETED', 'CALENDAR', calendar.id, before, null);
    return { id, deleted: true };
  }

  permissions(actor: ActorContext, id: string) {
    const calendar = this.policy.calendar(actor, id);
    this.policy.requireLevel(actor, calendar, 'MANAGE', 'calendar.permission_manage');
    return { calendarId: id, version: calendar.version, permissions: this.state.calendarPermissions.filter((row) => row.calendarId === id && row.workspaceId === actor.workspaceId) };
  }
  replacePermissions(actor: ActorContext, id: string, body: Body, ifMatch?: number) {
    const calendar = this.policy.calendar(actor, id);
    this.policy.requireLevel(actor, calendar, 'MANAGE', 'calendar.permission_manage');
    this.policy.assertWritable(calendar);
    body.only(['permissions', 'version']);
    this.support.expectVersion(calendar, body.raw.version ?? ifMatch);
    const input = body.array('permissions', { required: true, max: 500 })!;
    const seen = new Set<string>();
    const parsed = input.map((raw) => {
      const entry = new Body(raw as Record<string, unknown>);
      entry.only(['subjectType', 'subjectId', 'level']);
      const subjectType = entry.enumOf('subjectType', CALENDAR_SUBJECTS, { required: true });
      const level = entry.enumOf('level', CALENDAR_LEVELS, { required: true });
      const rawSubjectId = entry.str('subjectId') ?? null;
      const subjectId = subjectType === 'PROJECT_ROLE' ? rawSubjectId : rawSubjectId?.toLowerCase() ?? null;
      const invalid = () => new AppError('CALENDAR_PERMISSION_INVALID', 'Calendar permission subject must be valid in this Workspace.', 400);
      if (subjectType === 'WORKSPACE') { if (subjectId !== null) throw invalid(); }
      else if (subjectType === 'PROJECT_ROLE') {
        if (!calendar.projectId || !['OWNER', 'MODERATOR', 'MEMBER'].includes(subjectId ?? '')) throw invalid();
      } else {
        if (!isUuid(subjectId)) throw invalid();
        if (subjectType === 'USER' && !this.support.isEligibleUser(calendar.workspaceId, subjectId)) throw invalid();
        if (subjectType === 'ROLE' && !this.state.roles.some((row) => row.id === subjectId && row.workspaceId === calendar.workspaceId && !row.isDeleted)) throw invalid();
        if ((subjectType === 'DEPARTMENT' || subjectType === 'DEPARTMENT_TREE') && !this.state.departments.some((row) => row.id === subjectId && row.workspaceId === calendar.workspaceId && !row.isDeleted)) throw invalid();
      }
      const normalizedId = subjectType !== 'PROJECT_ROLE' ? subjectId?.toLowerCase() ?? null : subjectId;
      const key = `${subjectType}:${normalizedId}`;
      if (seen.has(key)) throw invalid();
      seen.add(key);
      return { subjectType, subjectId: normalizedId, level };
    });
    const before = this.state.calendarPermissions.filter((row) => row.calendarId === id);
    const rows: CalendarPermission[] = parsed.map((row) => ({ ...row, id: this.support.id(), workspaceId: calendar.workspaceId, calendarId: id }));
    this.state.calendarPermissions = this.state.calendarPermissions.filter((row) => row.calendarId !== id);
    this.state.calendarPermissions.push(...rows);
    this.support.touch(calendar);
    this.event(calendar, 'CALENDAR_PERMISSION_CHANGED', actor.user.id, { permissionCount: rows.length });
    this.support.audit(actor, calendar.workspaceId, 'CALENDAR.PERMISSIONS_CHANGED', 'CALENDAR', id, { permissions: before }, { permissions: rows });
    // Return the accepted snapshot even when a non-owner manager removed their own grant.
    return { calendarId: id, version: calendar.version, permissions: rows };
  }

  preferences(actor: ActorContext, id: string) { return this.preferencesOf(actor, this.policy.calendar(actor, id)); }
  updatePreferences(actor: ActorContext, id: string, body: Body, ifMatch?: number) {
    const calendar = this.policy.calendar(actor, id);
    body.only(['colorPreference', 'isVisible', 'version']);
    let row = this.state.userCalendarPreferences.find((p) => p.workspaceId === actor.workspaceId && p.calendarId === id && p.userId === actor.user.id);
    if (row) this.support.expectVersion(row, body.raw.version ?? ifMatch);
    else if ((body.raw.version ?? ifMatch) !== undefined && (body.raw.version ?? ifMatch) !== 0) throw validationError('version', 'An unsaved preference has version 0.');
    const color = body.has('colorPreference') ? this.color(body) ?? null : row?.colorPreference ?? null;
    const isVisible = body.bool('isVisible') ?? row?.isVisible ?? true;
    if (row) { Object.assign(row, { colorPreference: color, isVisible }); this.support.touch(row); }
    else {
      const now = this.support.now();
      row = { id: this.support.id(), workspaceId: calendar.workspaceId, calendarId: id, userId: actor.user.id, colorPreference: color, isVisible, version: 1, createdAt: now, updatedAt: now } satisfies UserCalendarPreference;
      this.state.userCalendarPreferences.push(row);
    }
    return row;
  }

  /** Registered with ProjectService; all writes to Calendar rows remain in the Calendar owning service. */
  projectProvisioner(): ProjectResourceProvisioner {
    return {
      toolType: 'CALENDAR', resourceType: 'CALENDAR',
      provision: (project, actorUserId) => this.provision(project, actorUserId),
      setReadOnly: (project, id, readOnly) => {
        const calendar = this.state.calendars.find((row) => row.id === id && row.workspaceId === project.workspaceId && row.projectId === project.id);
        if (calendar && calendar.isReadOnly !== readOnly) {
          calendar.isReadOnly = readOnly; this.support.touch(calendar); this.event(calendar, 'CALENDAR_UPDATED', null, { isReadOnly: readOnly });
        }
      },
      // Project access is derived from current Project membership rather than duplicated ACL rows.
      syncProjectMembers: () => {},
      detach: (project) => {
        for (const calendar of this.state.calendars.filter((row) => row.workspaceId === project.workspaceId && row.projectId === project.id)) {
          calendar.projectId = null; calendar.ownerUserId = calendar.createdByUserId; calendar.isReadOnly = true;
          this.support.touch(calendar); this.event(calendar, 'CALENDAR_UPDATED', null, { projectDetached: true });
        }
      },
    };
  }
  private provision(project: Project, actorUserId: string) {
    const existing = this.state.calendars.find((row) => row.workspaceId === project.workspaceId && row.projectId === project.id);
    if (existing) return existing.id;
    const now = this.support.now();
    const calendar: Calendar = {
      id: this.support.id(), workspaceId: project.workspaceId, type: 'PROJECT', ownerUserId: null, departmentId: null, projectId: project.id,
      createdByUserId: actorUserId, name: project.name, description: null, timezone: 'UTC', colorPreference: null,
      isActive: true, isReadOnly: project.status === 'ARCHIVED', isDeleted: false, version: 1, createdAt: now, updatedAt: now,
    };
    this.state.calendars.push(calendar);
    this.event(calendar, 'CALENDAR_CREATED', actorUserId, { type: calendar.type, projectId: project.id });
    return calendar.id;
  }
}
