import type { HrEmployee } from '@prisma/client';
import { AppError } from '../errors';
import { requirePermission, type Principal, type Tx } from '../process-platform/context';
import { entitled, notFound } from '../suite/kernel';

export type Access = 'SELF' | 'MANAGER' | 'DEPARTMENT' | 'ALL';

/** Departments visible to the actor: own departments (+ descendants for DEPARTMENT_TREE scope). */
export async function visibleDepartments(tx: Tx, actor: Principal, permission: string) {
  const scope = actor.grants.get(permission);
  if (!scope) return new Set<string>();
  const own = (await tx.departmentMember.findMany({ where: { workspaceId: actor.workspaceId, userId: actor.userId, isDeleted: false } })).map(m => m.departmentId);
  const managed = (await tx.department.findMany({ where: { workspaceId: actor.workspaceId, managerId: actor.userId, isDeleted: false } })).map(d => d.id);
  const result = new Set([...own, ...managed]);
  if (scope === 'DEPARTMENT_TREE' || scope === 'WORKSPACE') {
    const all = await tx.department.findMany({ where: { workspaceId: actor.workspaceId, isDeleted: false }, select: { id: true, parentDepartmentId: true } });
    let grew = true;
    while (grew) { grew = false; for (const d of all) if (d.parentDepartmentId && result.has(d.parentDepartmentId) && !result.has(d.id)) { result.add(d.id); grew = true; } }
  }
  return result;
}

export async function myEmployee(tx: Tx, actor: Principal, required = true) {
  const row = await tx.hrEmployee.findFirst({ where: { workspaceId: actor.workspaceId, userId: actor.userId, status: { in: ['ACTIVE', 'ON_LEAVE'] } } });
  if (!row && required) throw new AppError('PERMISSION_DENIED', 'An active employee profile is required.', 403);
  return row;
}

/** True when the actor's employee profile is in the target's manager chain. */
export async function isManagerOf(tx: Tx, actor: Principal, target: HrEmployee) {
  const me = await myEmployee(tx, actor, false); if (!me || me.id === target.id) return false;
  let current: string | null = target.managerEmployeeId; const seen = new Set<string>();
  while (current && !seen.has(current)) { if (current === me.id) return true; seen.add(current); current = (await tx.hrEmployee.findFirst({ where: { workspaceId: actor.workspaceId, id: current }, select: { managerEmployeeId: true } }))?.managerEmployeeId ?? null; }
  return false;
}

/**
 * Team authority for approvals/visibility: manager chain or department scope of the given team permission.
 * Self never counts as team (no self-approval).
 */
export async function teamAuthority(tx: Tx, actor: Principal, target: HrEmployee, permission: string) {
  if (target.userId === actor.userId) return false;
  const scope = actor.grants.get(permission); if (!scope) return false;
  if (scope === 'WORKSPACE') return true;
  if (await isManagerOf(tx, actor, target)) return true;
  if (scope === 'OWN') return false;
  return Boolean(target.departmentId && (await visibleDepartments(tx, actor, permission)).has(target.departmentId));
}

/** Directory read: self / department(-tree) / all. Foreign or invisible employees are concealed as 404. */
export async function readableEmployee(tx: Tx, actor: Principal, id: string): Promise<{ employee: HrEmployee; access: Access }> {
  entitled(actor, 'hr');
  const employee = await tx.hrEmployee.findFirst({ where: { workspaceId: actor.workspaceId, id } });
  if (!employee) throw notFound('Employee');
  if (actor.grants.has('hr.employee.read_all')) return { employee, access: 'ALL' };
  if (employee.userId === actor.userId && actor.grants.has('hr.employee.read_self')) return { employee, access: 'SELF' };
  if (actor.grants.has('hr.employee.read_department')) {
    if (await isManagerOf(tx, actor, employee)) return { employee, access: 'MANAGER' };
    if (employee.departmentId && (await visibleDepartments(tx, actor, 'hr.employee.read_department')).has(employee.departmentId)) return { employee, access: 'DEPARTMENT' };
  }
  throw notFound('Employee');
}
export async function managedEmployee(tx: Tx, actor: Principal, id: string) {
  requirePermission(actor, 'hr.employee.manage'); entitled(actor, 'hr');
  const employee = await tx.hrEmployee.findFirst({ where: { workspaceId: actor.workspaceId, id } });
  if (!employee) throw notFound('Employee');
  if (actor.grants.get('hr.employee.manage') !== 'WORKSPACE' && !(employee.departmentId && (await visibleDepartments(tx, actor, 'hr.employee.manage')).has(employee.departmentId))) throw notFound('Employee');
  return employee;
}
/** Directory-safe projection; confidential employment data is never included here. */
export function directoryView(e: HrEmployee) {
  return { id: e.id, employeeNumber: e.employeeNumber, displayName: e.displayName, status: e.status, departmentId: e.departmentId, managerEmployeeId: e.managerEmployeeId, positionId: e.positionId,
    workLocationId: e.workLocationId, timezone: e.timezone, startDate: e.startDate.toISOString().slice(0, 10), endDate: e.endDate?.toISOString().slice(0, 10) ?? null, version: e.version, userId: e.userId };
}
export function minutesBetween(a: Date, b: Date) { return Math.max(0, Math.round((b.getTime() - a.getTime()) / 60000)); }
