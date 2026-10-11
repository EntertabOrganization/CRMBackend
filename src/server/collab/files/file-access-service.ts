import type { ActorContext } from '../../access-service';
import { AppError } from '../../errors';
import { Body, type CollabSupport, isUuid } from '../support';
import type { FilePermissionAssignment, ProjectFileStorage } from './types';
import type { ProjectDriveService } from './project-drive-service';

type ResourceType = FilePermissionAssignment['resourceType'];
const SUBJECTS = ['USER', 'ROLE', 'DEPARTMENT', 'DEPARTMENT_TREE', 'PROJECT_ROLE', 'WORKSPACE', 'EXTERNAL_GUEST'] as const;
const LEVELS = ['NONE', 'READ', 'ADD', 'EDIT', 'FULL'] as const;
const MODES = ['INHERIT', 'OVERRIDE'] as const;

/** ACL configuration requires both a platform action and effective FULL resource access. */
export class FileAccessService {
  constructor(private readonly support: CollabSupport, private readonly storages: ProjectDriveService) {}
  private resource(actor: ActorContext, type: ResourceType, id: string) {
    if (type === 'STORAGE') {
      return this.storages.storageAuthority(actor, id, 'file.permission_manage');
    }
    if (type === 'FILE') return this.storages.fileAuthority(actor, id, 'file.permission_manage', 4);
    // Read-only content remains administrable: security grants can still be revoked.
    return this.storages.folderAuthority(actor, id, 'file.permission_manage', 4, false, false);
  }
  private assignments(actor: ActorContext, type: ResourceType, id: string) {
    return this.support.state.filePermissionAssignments.filter(row => row.workspaceId === actor.workspaceId && row.resourceType === type && row.resourceId === id);
  }
  get(actor: ActorContext, type: ResourceType, id: string) {
    const resource = this.resource(actor, type, id);
    return { resourceType: type, resourceId: id, version: resource.version, assignments: this.assignments(actor, type, id) };
  }
  replace(actor: ActorContext, type: ResourceType, id: string, body: Body, ifMatch?: number) {
    body.only(['assignments', 'version']);
    const resource = this.resource(actor, type, id);
    this.support.expectVersion(resource, body.raw.version ?? ifMatch);
    const input = body.raw.assignments;
    if (!Array.isArray(input) || input.length > 500) this.invalid('assignments must be an array with at most 500 entries.');
    const storage = type === 'STORAGE' ? resource as ProjectFileStorage : this.support.state.fileStorages.find(row => row.id === (resource as { storageId: string }).storageId)!;
    const seen = new Set<string>(), modes = new Set<string>();
    const assignments: FilePermissionAssignment[] = input.map(raw => {
      const entry = new Body(raw); entry.only(['subjectType', 'subjectId', 'permissionLevel', 'inheritanceMode']);
      const subjectType = entry.enumOf('subjectType', SUBJECTS, { required: true });
      let subjectId = entry.str('subjectId', { max: 100 }) ?? null;
      const permissionLevel = entry.enumOf('permissionLevel', LEVELS, { required: true });
      const inheritanceMode = entry.enumOf('inheritanceMode', MODES, { required: true });
      const state = this.support.state, workspaceId = actor.workspaceId;
      if (subjectType === 'WORKSPACE') {
        if (subjectId !== null && subjectId !== workspaceId) this.invalid('Workspace subjects must refer to this Workspace.');
        subjectId = null;
      } else if (subjectType === 'PROJECT_ROLE') {
        if (!storage.projectId || !state.projects.some(row => row.id === storage.projectId && row.workspaceId === workspaceId && !row.isDeleted) ||
          !['OWNER', 'MODERATOR', 'MEMBER', 'OBSERVER'].includes(subjectId ?? '')) this.invalid('Project-role subjects require a live Project storage.');
      } else {
        if (!isUuid(subjectId)) this.invalid('This subject requires a valid UUID.');
        subjectId = subjectId.toLowerCase();
        const valid = subjectType === 'USER' ? this.support.isEligibleUser(workspaceId, subjectId) :
          subjectType === 'ROLE' ? state.roles.some(row => row.id === subjectId && row.workspaceId === workspaceId && !row.isDeleted) :
          subjectType === 'DEPARTMENT' || subjectType === 'DEPARTMENT_TREE' ? state.departments.some(row => row.id === subjectId && row.workspaceId === workspaceId && !row.isDeleted) :
          state.collabSpaceMembers.some(row => row.workspaceId === workspaceId && row.userId === subjectId && row.status === 'ACTIVE' && row.memberType === 'EXTERNAL' && row.leftAt === null &&
            state.collabSpaces.some(space => space.id === row.collabId && space.workspaceId === workspaceId && space.status === 'ACTIVE'));
        if (!valid) this.invalid('The subject is not active in this Workspace.');
      }
      const key = `${subjectType}:${subjectId}`;
      if (seen.has(key)) this.invalid('Duplicate ACL subjects are not allowed.');
      seen.add(key); modes.add(inheritanceMode);
      return { id: this.support.id(), workspaceId: actor.workspaceId, resourceType: type, resourceId: id, subjectType, subjectId, permissionLevel, inheritanceMode };
    });
    if (modes.size > 1) this.invalid('All direct assignments must use the same inheritance mode.');
    const before = structuredClone(this.assignments(actor, type, id));
    this.support.state.filePermissionAssignments = this.support.state.filePermissionAssignments.filter(row => !(row.workspaceId === actor.workspaceId && row.resourceType === type && row.resourceId === id));
    this.support.state.filePermissionAssignments.push(...assignments); this.support.touch(resource);
    const entityType = type === 'STORAGE' ? 'FILE_STORAGE' : type === 'FILE' ? 'FILE' : 'FILE_FOLDER';
    this.support.audit(actor, actor.workspaceId, 'FILE.PERMISSION_CHANGED', entityType, id, { assignments: before }, { assignments });
    this.support.event({ workspaceId: actor.workspaceId, type: 'FILE_PERMISSION_CHANGED', entityType, entityId: id,
      actorUserId: actor.user.id, changes: { resourceType: type, version: resource.version } });
    return { resourceType: type, resourceId: id, version: resource.version, assignments };
  }
  private invalid(message: string): never { throw new AppError('FILE_PERMISSION_INVALID', message, 400); }
}
