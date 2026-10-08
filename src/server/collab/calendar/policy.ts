import type { ActorContext } from '../../access-service';
import { AppError, forbidden } from '../../errors';
import type { CollabSupport } from '../support';
import { notFoundError } from '../support';
import type { TasksPolicy } from '../tasks/policy';
import type { Calendar, CalendarLevel, CalendarPermission } from './types';
import { CALENDAR_LEVELS } from './types';

/** Platform actions remain mandatory; container relationships and ACL levels select accessible calendars. */
export class CalendarPolicy {
  constructor(private readonly support: CollabSupport, private readonly projects: TasksPolicy) {}
  private get state() { return this.support.state; }

  inDepartment(actor: ActorContext, departmentId: string, tree = false) {
    const departments = this.state.departments.filter((row) => row.workspaceId === actor.workspaceId && !row.isDeleted);
    const members = new Set(this.state.departmentMembers.filter((row) => row.workspaceId === actor.workspaceId && row.userId === actor.user.id && !row.isDeleted && departments.some((d) => d.id === row.departmentId)).map((row) => row.departmentId));
    if (members.has(departmentId)) return true;
    if (!tree) return false;
    for (const id of members) {
      const seen = new Set<string>();
      let current = departments.find((row) => row.id === id);
      while (current && !seen.has(current.id)) {
        if (current.id === departmentId) return true;
        seen.add(current.id);
        current = departments.find((row) => row.id === current!.parentDepartmentId);
      }
    }
    return false;
  }

  private matches(actor: ActorContext, calendar: Calendar, grant: CalendarPermission) {
    if (grant.workspaceId !== actor.workspaceId) return false;
    switch (grant.subjectType) {
      case 'WORKSPACE': return true;
      case 'USER': return grant.subjectId === actor.user.id;
      case 'ROLE': return grant.subjectId === actor.role.id;
      case 'DEPARTMENT': return Boolean(grant.subjectId && this.inDepartment(actor, grant.subjectId));
      case 'DEPARTMENT_TREE': return Boolean(grant.subjectId && this.inDepartment(actor, grant.subjectId, true));
      case 'PROJECT_ROLE': {
        const project = this.state.projects.find((row) => row.id === calendar.projectId && row.workspaceId === actor.workspaceId && !row.isDeleted);
        return Boolean(project && this.projects.projectRole(project, actor.user.id) === grant.subjectId);
      }
    }
  }

  /**
   * ACLs override default visibility/creation when configured. A matching USER entry takes priority over broader
   * subjects, allowing an explicit VIEW restriction. Calendar owners and workspace owners retain recovery management.
   * Department/project membership is read live: removing inherited access never erases a separate direct USER grant.
   */
  level(actor: ActorContext, calendar: Calendar): CalendarLevel | null {
    if (calendar.workspaceId !== actor.workspaceId || calendar.isDeleted || !this.support.scope(actor, 'calendar.read')) return null;
    if (actor.role.isOwnerRole || calendar.ownerUserId === actor.user.id) return 'MANAGE';
    const grants = this.state.calendarPermissions.filter((row) => row.workspaceId === actor.workspaceId && row.calendarId === calendar.id);
    if (grants.length) {
      const matching = grants.filter((row) => this.matches(actor, calendar, row));
      const direct = matching.filter((row) => row.subjectType === 'USER');
      return (direct.length ? direct : matching).sort((a, b) => CALENDAR_LEVELS.indexOf(b.level) - CALENDAR_LEVELS.indexOf(a.level))[0]?.level ?? null;
    }
    if (calendar.type === 'COMPANY') return 'VIEW';
    if (calendar.type === 'DEPARTMENT' && calendar.departmentId) {
      const department = this.state.departments.find((row) => row.id === calendar.departmentId && row.workspaceId === actor.workspaceId && !row.isDeleted);
      if (!department) return null;
      if (department.managerId === actor.user.id) return 'MANAGE';
      return this.inDepartment(actor, department.id) ? 'CREATE' : null;
    }
    if (calendar.type === 'PROJECT' && calendar.projectId) {
      const project = this.state.projects.find((row) => row.id === calendar.projectId && row.workspaceId === actor.workspaceId && !row.isDeleted);
      if (!project) return null;
      const role = this.projects.projectRole(project, actor.user.id);
      return role === 'OWNER' || role === 'MODERATOR' ? 'MANAGE' : role === 'MEMBER' ? 'CREATE' : null;
    }
    return null;
  }

  calendar(actor: ActorContext, id: string) {
    this.support.require(actor, 'calendar.read');
    const calendar = this.state.calendars.find((row) => row.id === id && row.workspaceId === actor.workspaceId && !row.isDeleted);
    if (!calendar || !this.level(actor, calendar)) throw notFoundError('CALENDAR_NOT_FOUND', 'Calendar');
    return calendar;
  }

  requireLevel(actor: ActorContext, calendar: Calendar, level: CalendarLevel, permission: string) {
    this.support.require(actor, permission);
    const effective = this.level(actor, calendar);
    if (!effective || CALENDAR_LEVELS.indexOf(effective) < CALENDAR_LEVELS.indexOf(level)) throw forbidden(`${permission} is not granted for this Calendar.`);
  }

  assertWritable(calendar: Calendar) {
    const project = this.state.projects.find((row) => row.id === calendar.projectId && row.workspaceId === calendar.workspaceId);
    if (project?.status === 'ARCHIVED') throw new AppError('PROJECT_ARCHIVED', 'The Project Calendar is read-only while its Project is archived.', 409);
    if (calendar.isReadOnly) throw new AppError('CALENDAR_READ_ONLY', 'This Calendar is read-only.', 409);
  }
}
