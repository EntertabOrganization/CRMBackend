import type { ActorContext } from '../access-service';
import type { InMemoryStore } from '../store';
import type { CustomField, FieldEffectiveAccess, FieldVisibilityRule } from './types';

const RANK: Record<FieldEffectiveAccess, number> = { HIDDEN: 0, READ_ONLY: 1, EDIT: 2 };

/**
 * Field-level rules can only NARROW access that the owning record already grants. The result is the most
 * restrictive of every rule that applies to the actor; there is deliberately no ALLOW rule that could override it.
 */
export class FieldPermissionService {
  constructor(private readonly store: InMemoryStore) {}

  rulesFor(fieldId: string): FieldVisibilityRule[] {
    return this.store.state.crmFieldVisibilityRules.filter((rule) => rule.fieldId === fieldId);
  }

  /** Restriction from field rules alone (record access is applied by the caller). */
  fieldAccess(actor: ActorContext, field: CustomField): FieldEffectiveAccess {
    let access: FieldEffectiveAccess = 'EDIT';
    for (const rule of this.rulesFor(field.id)) {
      if (!this.appliesToActor(actor, rule)) continue;
      const candidate: FieldEffectiveAccess = rule.restriction === 'HIDDEN' ? 'HIDDEN' : 'READ_ONLY';
      if (RANK[candidate] < RANK[access]) access = candidate;
    }
    return access;
  }

  /** Record access ∩ field rule: a field rule can never expand what the record permission allows. */
  effectiveAccess(actor: ActorContext, field: CustomField, record: { canRead: boolean; canUpdate: boolean }): FieldEffectiveAccess {
    if (!record.canRead) return 'HIDDEN';
    const fromRecord: FieldEffectiveAccess = record.canUpdate ? 'EDIT' : 'READ_ONLY';
    const fromField = this.fieldAccess(actor, field);
    return RANK[fromRecord] <= RANK[fromField] ? fromRecord : fromField;
  }

  private appliesToActor(actor: ActorContext, rule: FieldVisibilityRule): boolean {
    switch (rule.subjectType) {
      case 'ROLE':
        return actor.role.id === rule.subjectId;
      case 'USER':
        return actor.user.id === rule.subjectId;
      case 'DEPARTMENT':
        return this.userDepartments(actor).has(rule.subjectId);
      case 'DEPARTMENT_TREE': {
        const reachable = new Set<string>();
        this.collect(actor.workspaceId, rule.subjectId, reachable);
        return [...this.userDepartments(actor)].some((id) => reachable.has(id));
      }
      default:
        return false;
    }
  }

  private userDepartments(actor: ActorContext) {
    return new Set(
      this.store.state.departmentMembers
        .filter((item) => item.workspaceId === actor.workspaceId && item.userId === actor.user.id && !item.isDeleted)
        .map((item) => item.departmentId),
    );
  }

  private collect(workspaceId: string, departmentId: string, into: Set<string>) {
    if (into.has(departmentId)) return;
    into.add(departmentId);
    for (const child of this.store.state.departments) {
      if (child.workspaceId === workspaceId && !child.isDeleted && child.parentDepartmentId === departmentId) {
        this.collect(workspaceId, child.id, into);
      }
    }
  }
}
