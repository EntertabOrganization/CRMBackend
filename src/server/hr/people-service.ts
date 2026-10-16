import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors';
import { parse, uuid } from '../process-platform/dto';
import { evidence, lock, requirePermission, type Principal, type Tx } from '../process-platform/context';
import { asDate, assertVersion, decrypt, encrypt, expectedVersion, ianaZone, inTx, listQuery, localDate, notFound, paged, transition } from '../suite/kernel';
import { cleanFile } from '../suite/files-port';
import { directoryView, managedEmployee, readableEmployee, visibleDepartments } from './support';

const privateFields = z.strictObject({ personalEmail: z.email().optional(), phone: z.string().max(40).optional(), address: z.string().max(500).optional(), nationalIdRef: z.string().max(80).optional(),
  emergencyContact: z.string().max(300).optional(), salaryBand: z.string().max(80).optional(), notes: z.string().max(2000).optional() });
const statusMachine: Record<string, readonly string[]> = { INVITED: ['ACTIVE', 'TERMINATED'], ACTIVE: ['ON_LEAVE', 'TERMINATED'], ON_LEAVE: ['ACTIVE', 'TERMINATED'], TERMINATED: [] };

/** Employee profiles, positions, lifecycle and confidential documents (specs HR/01, HR/10). EmployeeProfile ≠ Auth User. */
export class HrPeopleService {
  constructor(private readonly db: PrismaClient) {}

  private async references(tx: Tx, actor: Principal, input: { userId?: string | null; departmentId?: string | null; managerEmployeeId?: string | null; positionId?: string | null; workLocationId?: string | null }, selfId?: string) {
    if (input.userId && !await tx.workspaceMembership.findFirst({ where: { workspaceId: actor.workspaceId, userId: input.userId, isDeleted: false } })) throw notFound('User membership');
    if (input.departmentId && !await tx.department.findFirst({ where: { workspaceId: actor.workspaceId, id: input.departmentId, isDeleted: false } })) throw notFound('Department');
    if (input.positionId && !await tx.hrPosition.findFirst({ where: { workspaceId: actor.workspaceId, id: input.positionId } })) throw notFound('Position');
    if (input.workLocationId && !await tx.hrWorkLocation.findFirst({ where: { workspaceId: actor.workspaceId, id: input.workLocationId } })) throw notFound('Work location');
    if (input.managerEmployeeId) {
      if (input.managerEmployeeId === selfId) throw new AppError('VALIDATION_FAILED', 'An employee cannot supervise themselves.', 400, { fields: [{ field: 'managerEmployeeId', reason: 'SELF_SUPERVISION' }] });
      let current: string | null = input.managerEmployeeId; const seen = new Set<string>();
      while (current) {
        if (current === selfId || seen.has(current)) throw new AppError('VALIDATION_FAILED', 'Manager hierarchy cannot contain cycles.', 400, { fields: [{ field: 'managerEmployeeId', reason: 'CYCLE' }] });
        seen.add(current);
        const manager: { managerEmployeeId: string | null } | null = await tx.hrEmployee.findFirst({ where: { workspaceId: actor.workspaceId, id: current }, select: { managerEmployeeId: true } });
        if (!manager) throw notFound('Manager');
        current = manager.managerEmployeeId;
      }
    }
  }

  async create(actor: Principal, raw: unknown) {
    const input = parse(z.strictObject({ employeeNumber: z.string().trim().min(1).max(40), displayName: z.string().trim().min(1).max(160), userId: uuid.optional(), departmentId: uuid.optional(), managerEmployeeId: uuid.optional(),
      positionId: uuid.optional(), workLocationId: uuid.optional(), employmentType: z.enum(['FULL_TIME', 'PART_TIME', 'CONTRACTOR', 'TEMPORARY', 'INTERN']).default('FULL_TIME'), timezone: ianaZone, startDate: localDate, privateData: privateFields.optional() }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'hr.employee.manage');
      if (input.privateData) requirePermission(actor, 'hr.employee.private.write');
      if (typeof actor.entitlements?.hrEmployeeLimit === 'number' && await tx.hrEmployee.count({ where: { workspaceId: actor.workspaceId, status: { not: 'TERMINATED' } } }) >= actor.entitlements.hrEmployeeLimit) throw new AppError('PLAN_LIMIT_REACHED', 'Employee quota reached.', 403);
      await this.references(tx, actor, input);
      if (input.userId) { await lock(tx, actor.workspaceId, 'hr:user:' + input.userId); if (await tx.hrEmployee.findFirst({ where: { workspaceId: actor.workspaceId, userId: input.userId, status: { not: 'TERMINATED' } } })) throw new AppError('INVALID_STATE_TRANSITION', 'User already has an active employee profile.', 409); }
      const { privateData, startDate, ...data } = input;
      const row = await tx.hrEmployee.create({ data: { workspaceId: actor.workspaceId, ...data, startDate: asDate(startDate), privateSealed: privateData ? encrypt(JSON.stringify(privateData)) : null, createdByUserId: actor.userId } });
      await tx.hrEmploymentRecord.create({ data: { workspaceId: actor.workspaceId, employeeId: row.id, employmentType: row.employmentType, positionId: row.positionId, effectiveFrom: row.startDate } });
      await evidence(tx, actor, 'HR_EMPLOYEE', row.id, 'EMPLOYEE_CREATED', { employeeNumber: row.employeeNumber, hasPrivateData: Boolean(privateData) });
      return directoryView(row);
    });
  }
  async list(actor: Principal, raw: unknown) {
    const q = parse(listQuery.extend({ departmentId: uuid.optional() }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      const where = { workspaceId: actor.workspaceId, ...(q.status ? { status: q.status } : {}), ...(q.departmentId ? { departmentId: q.departmentId } : {}), ...(q.search ? { displayName: { contains: q.search, mode: 'insensitive' as const } } : {}) };
      if (actor.grants.has('hr.employee.read_all')) {
        const [rows, total] = await Promise.all([tx.hrEmployee.findMany({ where, orderBy: [{ displayName: 'asc' }, { id: 'asc' }], skip: (q.page - 1) * q.limit, take: q.limit }), tx.hrEmployee.count({ where })]);
        return paged(rows.map(directoryView), total, q.page, q.limit);
      }
      if (!actor.grants.has('hr.employee.read_department') && !actor.grants.has('hr.employee.read_self')) requirePermission(actor, 'hr.employee.read_self');
      const departments = actor.grants.has('hr.employee.read_department') ? [...await visibleDepartments(tx, actor, 'hr.employee.read_department')] : [];
      const rows = await tx.hrEmployee.findMany({ where: { ...where, OR: [{ userId: actor.userId }, ...(departments.length ? [{ departmentId: { in: departments } }] : [])] }, orderBy: [{ displayName: 'asc' }, { id: 'asc' }] });
      return paged(rows.slice((q.page - 1) * q.limit, q.page * q.limit).map(directoryView), rows.length, q.page, q.limit);
    });
  }
  /** Detail: confidential fields require hr.employee.private.read (self sees own approved private profile); sensitive reads are audited. */
  async get(actor: Principal, id: string) {
    return inTx(this.db, actor, async (tx, actor) => {
      const { employee, access } = await readableEmployee(tx, actor, parse(uuid, id));
      const view: Record<string, unknown> = directoryView(employee);
      if (employee.privateSealed && (actor.grants.has('hr.employee.private.read') && access !== 'SELF' || access === 'SELF')) {
        const data = JSON.parse(decrypt(employee.privateSealed)!) as Record<string, unknown>;
        // Self-service shows contact data but never salary bands or HR notes.
        view.privateData = access === 'SELF' && !actor.grants.has('hr.employee.private.read') ? { personalEmail: data.personalEmail, phone: data.phone, address: data.address, emergencyContact: data.emergencyContact } : data;
        await tx.hrAccessAudit.create({ data: { workspaceId: actor.workspaceId, actorUserId: actor.userId, employeeId: employee.id, fields: Object.keys(view.privateData as object) } });
        await evidence(tx, actor, 'HR_EMPLOYEE', employee.id, 'HR_SENSITIVE_RECORD_ACCESSED', { fieldCount: Object.keys(view.privateData as object).length });
      }
      view.employment = await tx.hrEmploymentRecord.findMany({ where: { workspaceId: actor.workspaceId, employeeId: employee.id }, orderBy: { effectiveFrom: 'asc' }, select: { employmentType: true, positionId: true, effectiveFrom: true, effectiveTo: true } });
      return view;
    });
  }
  async patch(actor: Principal, id: string, raw: unknown) {
    const input = parse(z.strictObject({ expectedVersion, displayName: z.string().trim().min(1).max(160).optional(), departmentId: uuid.nullable().optional(), managerEmployeeId: uuid.nullable().optional(), positionId: uuid.nullable().optional(),
      workLocationId: uuid.nullable().optional(), timezone: ianaZone.optional(), employmentType: z.enum(['FULL_TIME', 'PART_TIME', 'CONTRACTOR', 'TEMPORARY', 'INTERN']).optional(), privateData: privateFields.optional(), effectiveFrom: localDate.optional() }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      const employee = await managedEmployee(tx, actor, parse(uuid, id)); assertVersion(employee.version, input.expectedVersion);
      if (employee.status === 'TERMINATED') throw new AppError('INVALID_STATE_TRANSITION', 'Terminated profiles are read-only; rehire creates a new employment period.', 409);
      if (input.privateData) requirePermission(actor, 'hr.employee.private.write');
      await this.references(tx, actor, input, employee.id);
      const { expectedVersion: _v, privateData, effectiveFrom, ...data } = input; void _v;
      const merged = privateData ? { ...(employee.privateSealed ? JSON.parse(decrypt(employee.privateSealed)!) : {}), ...privateData } : null;
      const updated = await tx.hrEmployee.update({ where: { id: employee.id }, data: { ...data, ...(merged ? { privateSealed: encrypt(JSON.stringify(merged)) } : {}), version: { increment: 1 } } });
      if (data.employmentType && data.employmentType !== employee.employmentType || data.positionId !== undefined && data.positionId !== employee.positionId) {
        const from = asDate(effectiveFrom ?? new Date().toISOString().slice(0, 10));
        await tx.hrEmploymentRecord.updateMany({ where: { workspaceId: actor.workspaceId, employeeId: employee.id, effectiveTo: null }, data: { effectiveTo: from } });
        await tx.hrEmploymentRecord.create({ data: { workspaceId: actor.workspaceId, employeeId: employee.id, employmentType: updated.employmentType, positionId: updated.positionId, effectiveFrom: from } });
      }
      if (data.managerEmployeeId !== undefined && data.managerEmployeeId !== employee.managerEmployeeId) await evidence(tx, actor, 'HR_EMPLOYEE', employee.id, 'EMPLOYEE_MANAGER_CHANGED', { from: employee.managerEmployeeId, to: data.managerEmployeeId });
      await evidence(tx, actor, 'HR_EMPLOYEE', employee.id, 'EMPLOYEE_CHANGED', { fields: Object.keys(data), privateChanged: Boolean(privateData) });
      return directoryView(updated);
    });
  }
  async activate(actor: Principal, id: string, raw: unknown) {
    const input = parse(z.strictObject({ expectedVersion }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      const employee = await managedEmployee(tx, actor, parse(uuid, id)); assertVersion(employee.version, input.expectedVersion);
      transition(statusMachine, employee.status, 'ACTIVE');
      const updated = await tx.hrEmployee.update({ where: { id: employee.id }, data: { status: 'ACTIVE', version: { increment: 1 } } });
      await evidence(tx, actor, 'HR_EMPLOYEE', employee.id, 'EMPLOYEE_ACTIVATED', {});
      return directoryView(updated);
    });
  }
  /** Termination schedules workspace access revocation; attendance, leave and audit history are retained. */
  async terminate(actor: Principal, id: string, raw: unknown) {
    const input = parse(z.strictObject({ expectedVersion, endDate: localDate, reason: z.string().trim().min(1).max(500), revokeAccessAt: z.iso.datetime({ offset: true }).optional() }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      const employee = await managedEmployee(tx, actor, parse(uuid, id)); assertVersion(employee.version, input.expectedVersion);
      requirePermission(actor, 'hr.lifecycle.manage'); transition(statusMachine, employee.status, 'TERMINATED');
      const updated = await tx.hrEmployee.update({ where: { id: employee.id }, data: { status: 'TERMINATED', endDate: asDate(input.endDate), version: { increment: 1 } } });
      await tx.hrEmploymentRecord.updateMany({ where: { workspaceId: actor.workspaceId, employeeId: employee.id, effectiveTo: null }, data: { effectiveTo: asDate(input.endDate) } });
      const lifecycle = await tx.hrLifecycleCase.create({ data: { workspaceId: actor.workspaceId, employeeId: employee.id, kind: 'OFFBOARDING', effectiveDate: asDate(input.endDate), status: 'APPROVED', createdByUserId: actor.userId, checklist: [{ item: 'REVOKE_WORKSPACE_ACCESS', mandatory: true, done: false }] } });
      if (employee.userId) await tx.hrAccessTransition.create({ data: { workspaceId: actor.workspaceId, employeeId: employee.id, caseId: lifecycle.id, userId: employee.userId, effectiveAt: input.revokeAccessAt ? new Date(input.revokeAccessAt) : new Date(), action: 'REVOKE_WORKSPACE_MEMBERSHIP', executionKey: 'revoke:' + lifecycle.id } });
      await tx.hrShiftAssignment.updateMany({ where: { workspaceId: actor.workspaceId, employeeId: employee.id, status: 'ASSIGNED' }, data: { status: 'CANCELLED' } });
      await evidence(tx, actor, 'HR_EMPLOYEE', employee.id, 'EMPLOYEE_TERMINATED', { endDate: input.endDate, lifecycleCaseId: lifecycle.id });
      return { ...directoryView(updated), lifecycleCaseId: lifecycle.id };
    });
  }
  async positions(actor: Principal, raw?: unknown) {
    if (raw === undefined) return inTx(this.db, actor, async (tx, actor) => { requirePermission(actor, 'hr.employee.read_self'); return tx.hrPosition.findMany({ where: { workspaceId: actor.workspaceId }, orderBy: { title: 'asc' } }); });
    const input = parse(z.strictObject({ title: z.string().trim().min(1).max(160), grade: z.string().max(40).optional() }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'hr.employee.manage');
      const row = await tx.hrPosition.create({ data: { workspaceId: actor.workspaceId, ...input } });
      await evidence(tx, actor, 'HR_POSITION', row.id, 'POSITION_CREATED', {}); return row;
    });
  }

  // ------------------------------------------------------------------ lifecycle
  async onboard(actor: Principal, id: string, raw: unknown) {
    const input = parse(z.strictObject({ effectiveDate: localDate, taskIds: z.array(uuid).max(100).default([]), checklist: z.array(z.strictObject({ item: z.string().min(1).max(200), mandatory: z.boolean().default(true) })).max(100).default([]), workflowDefinitionId: uuid.optional() }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'hr.lifecycle.manage');
      const employee = await managedEmployee(tx, actor, parse(uuid, id));
      for (const taskId of input.taskIds) if (!await tx.task.findFirst({ where: { workspaceId: actor.workspaceId, id: taskId } })) throw notFound('Task');
      let workflowExecutionId: string | null = null;
      if (input.workflowDefinitionId) {
        const { WorkflowExecutionService } = await import('../workflows/execution-service');
        // The shared Workflow engine runs a version-pinned case bound to the onboarding checklist Task.
        if (!input.taskIds.length) throw new AppError('VALIDATION_FAILED', 'Workflow-driven onboarding requires a checklist Task.', 400, { fields: [{ field: 'taskIds', reason: 'REQUIRED' }] });
        const started = await new WorkflowExecutionService(this.db).startInTransaction(tx, actor, input.workflowDefinitionId, { entityType: 'TASK', entityId: input.taskIds[0], parameters: {} }, 'onboarding:' + employee.id) as { executionId: string };
        workflowExecutionId = started.executionId;
      }
      const row = await tx.hrLifecycleCase.create({ data: { workspaceId: actor.workspaceId, employeeId: employee.id, kind: 'ONBOARDING', effectiveDate: asDate(input.effectiveDate), status: 'IN_PROGRESS', workflowExecutionId, createdByUserId: actor.userId,
        checklist: [...input.checklist.map(c => ({ ...c, done: false })), ...input.taskIds.map(t => ({ item: 'TASK', taskId: t, mandatory: true, done: false }))] } });
      await evidence(tx, actor, 'HR_EMPLOYEE', employee.id, 'ONBOARDING_STARTED', { caseId: row.id, workflowExecutionId });
      return row;
    });
  }
  async offboard(actor: Principal, id: string, raw: unknown) {
    const input = parse(z.strictObject({ effectiveAt: z.iso.datetime({ offset: true }), reason: z.string().trim().min(1).max(500) }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'hr.lifecycle.manage');
      const employee = await managedEmployee(tx, actor, parse(uuid, id));
      const row = await tx.hrLifecycleCase.create({ data: { workspaceId: actor.workspaceId, employeeId: employee.id, kind: 'OFFBOARDING', effectiveDate: new Date(input.effectiveAt), status: 'APPROVED', createdByUserId: actor.userId, checklist: [{ item: 'REVOKE_WORKSPACE_ACCESS', mandatory: true, done: false }] } });
      if (employee.userId) await tx.hrAccessTransition.create({ data: { workspaceId: actor.workspaceId, employeeId: employee.id, caseId: row.id, userId: employee.userId, effectiveAt: new Date(input.effectiveAt), action: 'REVOKE_WORKSPACE_MEMBERSHIP', executionKey: 'revoke:' + row.id } });
      await evidence(tx, actor, 'HR_EMPLOYEE', employee.id, 'OFFBOARDING_APPROVED', { caseId: row.id, effectiveAt: input.effectiveAt });
      return row;
    });
  }
  async lifecycle(actor: Principal, caseId: string) {
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'hr.lifecycle.manage');
      const row = await tx.hrLifecycleCase.findFirst({ where: { workspaceId: actor.workspaceId, id: parse(uuid, caseId) } });
      if (!row) throw notFound('Lifecycle case');
      await managedEmployee(tx, actor, row.employeeId);
      return { ...row, accessTransitions: await tx.hrAccessTransition.findMany({ where: { workspaceId: actor.workspaceId, caseId: row.id }, select: { id: true, action: true, effectiveAt: true, status: true, attempts: true, errorCode: true, completedAt: true } }) };
    });
  }
  /** Document access requires BOTH HR document rights and the shared File ACL (intersection). */
  async bindDocument(actor: Principal, id: string, raw: unknown) {
    const input = parse(z.strictObject({ fileId: uuid, category: z.enum(['CONTRACT', 'ID', 'CERTIFICATE', 'POLICY_ACK', 'MEDICAL', 'OTHER']), confidentiality: z.enum(['STANDARD', 'CONFIDENTIAL']), expiresAt: localDate.optional() }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'hr.documents.manage');
      const employee = await managedEmployee(tx, actor, parse(uuid, id));
      await cleanFile(tx, actor, input.fileId);
      const row = await tx.hrDocumentBinding.create({ data: { workspaceId: actor.workspaceId, employeeId: employee.id, fileId: input.fileId, category: input.category, confidentiality: input.confidentiality, expiresAt: input.expiresAt ? asDate(input.expiresAt) : null, createdByUserId: actor.userId } });
      await evidence(tx, actor, 'HR_EMPLOYEE', employee.id, 'EMPLOYEE_DOCUMENT_ATTACHED', { bindingId: row.id, category: row.category, confidentiality: row.confidentiality });
      return row;
    });
  }
  async documents(actor: Principal, id: string) {
    return inTx(this.db, actor, async (tx, actor) => {
      const { employee, access } = await readableEmployee(tx, actor, parse(uuid, id));
      const rows = await tx.hrDocumentBinding.findMany({ where: { workspaceId: actor.workspaceId, employeeId: employee.id, removedAt: null }, orderBy: { createdAt: 'desc' } });
      const visible = [];
      for (const row of rows) {
        if (row.confidentiality === 'CONFIDENTIAL' && !actor.grants.has('hr.documents.read_confidential')) continue;
        if (access !== 'SELF' && !actor.grants.has('hr.documents.manage') && !actor.grants.has('hr.documents.read_confidential')) continue;
        try { await cleanFile(tx, actor, row.fileId); visible.push(row); } catch { /* File ACL denies */ }
      }
      if (visible.some(v => v.confidentiality === 'CONFIDENTIAL')) await tx.hrAccessAudit.create({ data: { workspaceId: actor.workspaceId, actorUserId: actor.userId, employeeId: employee.id, fields: ['documents.confidential'] } });
      return visible;
    });
  }
  async removeDocument(actor: Principal, id: string, bindingId: string) {
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'hr.documents.manage');
      const employee = await managedEmployee(tx, actor, parse(uuid, id));
      const row = await tx.hrDocumentBinding.findFirst({ where: { workspaceId: actor.workspaceId, employeeId: employee.id, id: parse(uuid, bindingId), removedAt: null } });
      if (!row) throw notFound('Document binding');
      if (await tx.suiteLegalHold.findFirst({ where: { workspaceId: actor.workspaceId, module: 'hr', scopeId: employee.id, releasedAt: null } })) throw new AppError('INVALID_STATE_TRANSITION', 'Legal hold prevents removal.', 409);
      await tx.hrDocumentBinding.update({ where: { id: row.id }, data: { removedAt: new Date() } }); // binding soft-removed; File and audit retained
      await evidence(tx, actor, 'HR_EMPLOYEE', employee.id, 'EMPLOYEE_DOCUMENT_UNBOUND', { bindingId: row.id });
      return { id: row.id, removed: true };
    });
  }
}
