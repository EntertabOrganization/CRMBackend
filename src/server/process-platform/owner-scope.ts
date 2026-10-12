import { requirePermission, type Principal, type Tx } from './context';

/** Common ownership scope against active canonical Workspace membership and Department hierarchy. */
export async function ownerVisible(tx: Tx, actor: Principal, ownerUserId: string, permission: string) {
  const scope = requirePermission(actor,permission);
  if (scope === 'WORKSPACE' || actor.userId === ownerUserId) return true;
  if (scope === 'OWN') return false;
  const [self,owner,ownerMembership] = await Promise.all([
    tx.departmentMember.findMany({ where: { workspaceId: actor.workspaceId, userId: actor.userId, isDeleted: false, department: { workspaceId: actor.workspaceId,isDeleted: false } } }),
    tx.departmentMember.findMany({ where: { workspaceId: actor.workspaceId, userId: ownerUserId, isDeleted: false, department: { workspaceId: actor.workspaceId,isDeleted: false } } }),
    tx.workspaceMembership.findFirst({ where: { workspaceId: actor.workspaceId,userId: ownerUserId,status: 'ACTIVE',isDeleted: false } }),
  ]);
  if (!self.length || !owner.length || !ownerMembership) return false;
  const ownDepartments = new Set(self.map(member => member.departmentId));
  if (owner.some(member => ownDepartments.has(member.departmentId))) return true;
  if (scope !== 'DEPARTMENT_TREE') return false;
  const departments = await tx.department.findMany({ where: { workspaceId: actor.workspaceId, isDeleted: false }, select: { id: true, parentDepartmentId: true } });
  for (const member of owner) {
    const visited = new Set<string>(); let current: string | null = member.departmentId;
    while (current && !visited.has(current)) {
      if (ownDepartments.has(current)) return true;
      visited.add(current); current = departments.find(d => d.id === current)?.parentDepartmentId ?? null;
    }
  }
  return false;
}
