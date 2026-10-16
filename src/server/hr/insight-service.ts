import type { HrEmployee, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors';
import { parse, uuid } from '../process-platform/dto';
import { evidence, lock, requirePermission, type Principal, type Tx } from '../process-platform/context';
import { encodeCsv } from '../process-platform/csv';
import { asDate, expectedVersion, fromDate, inTx, localDate, notFound, transition } from '../suite/kernel';
import { myEmployee, teamAuthority, visibleDepartments } from './support';
import { HrWorktimeService } from './worktime-service';

const SMALL_GROUP = 3;

/** Work reports (HR/09) and privacy-first reporting, export and retention (HR/11). */
export class HrInsightService {
  constructor(private readonly db: PrismaClient) {}

  // ------------------------------------------------------------------ work reports
  private async visibleTasks(tx: Tx, actor: Principal, taskIds: string[]) {
    if (!taskIds.length) return [];
    // Task visibility is rechecked at read time: only tasks the actor can see are returned (IDs + titles only).
    const tasks = await tx.task.findMany({ where: { workspaceId: actor.workspaceId, id: { in: taskIds }, isDeleted: false }, select: { id: true, title: true, createdByUserId: true, responsibleUserId: true } });
    const members = await tx.taskMember.findMany({ where: { workspaceId: actor.workspaceId, taskId: { in: taskIds }, userId: actor.userId } });
    return tasks.filter(t => actor.grants.get('task.read') === 'WORKSPACE' || t.createdByUserId === actor.userId || t.responsibleUserId === actor.userId || members.some(m => m.taskId === t.id)).map(t => ({ id: t.id, title: t.title }));
  }
  async createReport(actor: Principal, raw: unknown) {
    const input = parse(z.strictObject({ periodType: z.enum(['DAY', 'WEEK', 'MONTH']), periodStart: localDate, periodEnd: localDate, summary: z.string().trim().min(1).max(10000), achievements: z.string().max(10000).default(''), blockers: z.string().max(10000).default(''), taskIds: z.array(uuid).max(100).default([]) }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'hr.workreport.create_self');
      const employee = await myEmployee(tx, actor) as HrEmployee;
      const visible = await this.visibleTasks(tx, actor, input.taskIds);
      if (visible.length !== input.taskIds.length) throw new AppError('NOT_FOUND', 'Task reference is not accessible.', 404);
      const row = await tx.hrWorkReport.create({ data: { workspaceId: actor.workspaceId, employeeId: employee.id, ...input, periodStart: asDate(input.periodStart), periodEnd: asDate(input.periodEnd) } });
      await evidence(tx, actor, 'HR_WORK_REPORT', row.id, 'WORK_REPORT_CREATED', { periodType: row.periodType });
      return row;
    });
  }
  private async report(tx: Tx, actor: Principal, id: string) {
    const row = await tx.hrWorkReport.findFirst({ where: { workspaceId: actor.workspaceId, id: parse(uuid, id) } });
    if (!row) throw notFound('Work report');
    const employee = await tx.hrEmployee.findUniqueOrThrow({ where: { id: row.employeeId } });
    const self = employee.userId === actor.userId, team = !self && await teamAuthority(tx, actor, employee, 'hr.workreport.read_team');
    if (!self && !team) throw notFound('Work report');
    return { row, employee, self };
  }
  async list(actor: Principal, raw: unknown) {
    const q = parse(z.object({ employeeId: uuid.optional(), status: z.string().optional() }).passthrough(), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      const rows = await tx.hrWorkReport.findMany({ where: { workspaceId: actor.workspaceId, ...(q.employeeId ? { employeeId: q.employeeId } : {}), ...(q.status ? { status: q.status } : {}) }, orderBy: { periodStart: 'desc' }, take: 500 });
      const out = []; for (const r of rows) try { await this.report(tx, actor, r.id); out.push(r); } catch { /* not visible */ }
      return out;
    });
  }
  async patch(actor: Principal, id: string, raw: unknown) {
    const input = parse(z.strictObject({ expectedVersion, summary: z.string().trim().min(1).max(10000).optional(), achievements: z.string().max(10000).optional(), blockers: z.string().max(10000).optional(), taskIds: z.array(uuid).max(100).optional() }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      const { row, self } = await this.report(tx, actor, id);
      if (!self) throw new AppError('PERMISSION_DENIED', 'Only the author edits a work report.', 403);
      if (!['DRAFT', 'RETURNED'].includes(row.status)) throw new AppError('INVALID_STATE_TRANSITION', 'Submitted or reviewed reports are immutable; a returned report creates a new revision.', 409);
      if (row.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT', 'Report changed; reload.', 409);
      if (input.taskIds && (await this.visibleTasks(tx, actor, input.taskIds)).length !== input.taskIds.length) throw new AppError('NOT_FOUND', 'Task reference is not accessible.', 404);
      const { expectedVersion: _v, ...data } = input; void _v;
      return tx.hrWorkReport.update({ where: { id: row.id }, data: { ...data, version: { increment: 1 } } });
    });
  }
  async transition(actor: Principal, id: string, raw: unknown, to: 'SUBMITTED' | 'REVIEWED' | 'RETURNED') {
    const input = parse(z.strictObject({ expectedVersion, comment: z.string().trim().max(2000).optional() }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      await lock(tx, actor.workspaceId, 'hr:workreport:' + id);
      const { row, employee, self } = await this.report(tx, actor, id);
      if (row.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT', 'Report changed; reload.', 409);
      if (to === 'SUBMITTED') { if (!self) throw new AppError('PERMISSION_DENIED', 'Only the author submits.', 403); }
      else if (self || !await teamAuthority(tx, actor, employee, 'hr.workreport.review_team')) throw new AppError('PERMISSION_DENIED', 'Not an authorized reviewer.', 403);
      transition({ DRAFT: ['SUBMITTED'], RETURNED: ['SUBMITTED'], SUBMITTED: ['REVIEWED', 'RETURNED'] }, row.status, to);
      const updated = await tx.hrWorkReport.update({ where: { id: row.id }, data: { status: to, version: { increment: 1 }, ...(to === 'SUBMITTED' && row.status === 'RETURNED' ? { revision: { increment: 1 } } : {}) } });
      if (to !== 'SUBMITTED') await tx.hrWorkReportReview.create({ data: { workspaceId: actor.workspaceId, reportId: row.id, revision: row.revision, reviewerUserId: actor.userId, decision: to, comment: input.comment,
        snapshot: { summary: row.summary, achievements: row.achievements, blockers: row.blockers, taskIds: row.taskIds } } });
      await evidence(tx, actor, 'HR_WORK_REPORT', row.id, 'WORK_REPORT_' + to, { revision: updated.revision });
      return updated;
    });
  }

  // ------------------------------------------------------------------ reports
  /** Reports inherit source scope: rows only for employees the actor may see; small departmental groups are suppressed. */
  private async scopedEmployees(tx: Tx, actor: Principal) {
    requirePermission(actor, 'hr.analytics.read');
    const all = await tx.hrEmployee.findMany({ where: { workspaceId: actor.workspaceId } });
    if (actor.grants.get('hr.analytics.read') === 'WORKSPACE') return all;
    const departments = await visibleDepartments(tx, actor, 'hr.analytics.read');
    return all.filter(e => e.departmentId && departments.has(e.departmentId) || e.userId === actor.userId);
  }
  async reportData(actor: Principal, kind: 'attendance' | 'leave' | 'headcount' | 'overtime', raw: unknown) {
    const q = parse(z.object({ from: localDate.optional(), to: localDate.optional(), groupBy: z.enum(['EMPLOYEE', 'DEPARTMENT']).default('DEPARTMENT') }).passthrough(), raw);
    const to = q.to ?? new Date().toISOString().slice(0, 10), from = q.from ?? new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    return inTx(this.db, actor, async (tx, actor) => {
      const employees = await this.scopedEmployees(tx, actor);
      const basis = { from, to, timezone: 'EMPLOYEE_LOCAL', policyVersion: 1, generatedAt: new Date(), source: 'REBUILT_FROM_HR_SOURCE' };
      if (q.groupBy === 'EMPLOYEE' && actor.grants.get('hr.analytics.read') !== 'WORKSPACE') throw new AppError('PERMISSION_DENIED', 'Row-level HR reports require workspace-wide analytics access.', 403);
      const rows: Record<string, unknown>[] = [];
      for (const e of employees) {
        if (kind === 'headcount') { rows.push({ employeeId: e.id, departmentId: e.departmentId, status: e.status, employmentType: e.employmentType }); continue; }
        if (kind === 'attendance') { const days = await HrWorktimeService.attendanceDays(tx, e, from, to); rows.push({ employeeId: e.id, departmentId: e.departmentId, workedMinutes: days.reduce((s, d) => s + d.workedMinutes, 0), expectedMinutes: days.reduce((s, d) => s + d.expectedMinutes, 0), anomalies: days.filter(d => d.status === 'ANOMALY').length, absences: days.filter(d => d.status === 'ABSENT').length }); continue; }
        if (kind === 'leave') { const leave = await tx.hrLeaveRequest.findMany({ where: { workspaceId: actor.workspaceId, employeeId: e.id, status: 'APPROVED', fromLocal: { lte: asDate(to) }, toLocal: { gte: asDate(from) } } }); rows.push({ employeeId: e.id, departmentId: e.departmentId, leaveUnits: leave.reduce((s, l) => s + Number(l.requestedUnits), 0), requests: leave.length }); continue; }
        const ot = await tx.hrOvertimeEntry.findMany({ where: { workspaceId: actor.workspaceId, employeeId: e.id, workDate: { gte: asDate(from), lte: asDate(to) } } });
        rows.push({ employeeId: e.id, departmentId: e.departmentId, calculatedMinutes: ot.reduce((s, o) => s + o.minutes, 0), approvedMinutes: ot.filter(o => o.status === 'APPROVED').reduce((s, o) => s + o.minutes, 0), payroll: 'NOT_CALCULATED' });
      }
      // Never includes reasons, diagnoses, documents or private fields.
      if (q.groupBy === 'EMPLOYEE') return { basis, rows };
      const groups = new Map<string, Record<string, number>>();
      for (const r of rows) { const key = String(r.departmentId ?? 'UNASSIGNED'), g = groups.get(key) ?? { employees: 0 }; g.employees++; for (const [k, v] of Object.entries(r)) if (typeof v === 'number') g[k] = (g[k] ?? 0) + v; groups.set(key, g); }
      return { basis, rows: [...groups].map(([departmentId, g]) => g.employees < SMALL_GROUP ? { departmentId, employees: g.employees, suppressed: true } : { departmentId, ...g }) };
    });
  }
  async exportReport(actor: Principal, raw: unknown) {
    const input = parse(z.strictObject({ kind: z.enum(['attendance', 'leave', 'headcount', 'overtime']), from: localDate.optional(), to: localDate.optional(), groupBy: z.enum(['EMPLOYEE', 'DEPARTMENT']).default('DEPARTMENT') }), raw);
    const data = await this.reportData(actor, input.kind, input);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'hr.analytics.export');
      const headers = [...new Set(data.rows.flatMap(r => Object.keys(r)))];
      await evidence(tx, actor, 'HR_REPORT', actor.userId, 'HR_REPORT_EXPORTED', { kind: input.kind, rows: data.rows.length, groupBy: input.groupBy });
      return { filename: `hr-${input.kind}-${data.basis.from}-${data.basis.to}.csv`, contentType: 'text/csv', base64: encodeCsv(headers, data.rows.map(r => headers.map(h => (r as Record<string, unknown>)[h]))).toString('base64'), basis: data.basis };
    });
  }

  // ------------------------------------------------------------------ retention & legal hold
  async retentionPolicy(actor: Principal, raw: unknown) {
    const input = parse(z.strictObject({ module: z.enum(['hr', 'commerce', 'marketing', 'sites']).default('hr'), jurisdiction: z.string().min(2).max(20), category: z.enum(['ATTENDANCE_EVIDENCE', 'WORK_EVENTS', 'LEAVE', 'DOCUMENTS', 'PROFILE', 'GUEST_DATA', 'AUDIENCE_IMPORTS', 'ENGAGEMENT', 'SITE_REVISIONS', 'VISITOR_DATA']),
      retentionDays: z.number().int().min(1).max(36500), effectiveFrom: localDate, legalBasis: z.string().trim().min(1).max(300), disposalMethod: z.enum(['DELETE', 'ANONYMIZE']), sensitiveFields: z.array(z.string().max(80)).max(50).default([]) }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, input.module === 'hr' ? 'hr.retention.manage' : 'audit.read');
      const row = await tx.suiteRetentionPolicy.create({ data: { workspaceId: actor.workspaceId, ...input, effectiveFrom: asDate(input.effectiveFrom) } });
      await evidence(tx, actor, 'SUITE_RETENTION_POLICY', row.id, 'RETENTION_POLICY_CONFIGURED', { module: row.module, category: row.category, jurisdiction: row.jurisdiction });
      return row;
    });
  }
  async legalHold(actor: Principal, raw: unknown) {
    const input = parse(z.strictObject({ employeeId: uuid.optional(), reason: z.string().trim().min(1).max(500), release: z.boolean().default(false), holdId: uuid.optional() }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'hr.retention.manage');
      if (input.release) {
        const hold = await tx.suiteLegalHold.findFirst({ where: { workspaceId: actor.workspaceId, id: input.holdId, releasedAt: null } });
        if (!hold) throw notFound('Legal hold');
        const updated = await tx.suiteLegalHold.update({ where: { id: hold.id }, data: { releasedAt: new Date() } });
        await evidence(tx, actor, 'SUITE_LEGAL_HOLD', hold.id, 'LEGAL_HOLD_RELEASED', {}); return updated;
      }
      if (input.employeeId && !await tx.hrEmployee.findFirst({ where: { workspaceId: actor.workspaceId, id: input.employeeId } })) throw notFound('Employee');
      const row = await tx.suiteLegalHold.create({ data: { workspaceId: actor.workspaceId, module: 'hr', scopeType: input.employeeId ? 'EMPLOYEE' : 'WORKSPACE', scopeId: input.employeeId, reason: input.reason, placedByUserId: actor.userId } });
      await evidence(tx, actor, 'SUITE_LEGAL_HOLD', row.id, 'LEGAL_HOLD_PLACED', { scopeType: row.scopeType }); return row;
    });
  }
  async retentionStatus(actor: Principal) {
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'hr.retention.manage');
      const policies = await tx.suiteRetentionPolicy.findMany({ where: { workspaceId: actor.workspaceId, module: 'hr' } });
      const holds = await tx.suiteLegalHold.findMany({ where: { workspaceId: actor.workspaceId, module: 'hr', releasedAt: null } });
      const required = ['ATTENDANCE_EVIDENCE', 'WORK_EVENTS', 'LEAVE', 'DOCUMENTS', 'PROFILE'];
      const terminated = await tx.hrEmployee.count({ where: { workspaceId: actor.workspaceId, status: 'TERMINATED' } });
      return { configured: required.filter(c => policies.some(p => p.category === c)), missing: required.filter(c => !policies.some(p => p.category === c)), productionReady: required.every(c => policies.some(p => p.category === c)),
        activeLegalHolds: holds.length, terminatedEmployeesRetained: terminated, note: 'No automatic purge on deactivation or subscription downgrade.' };
    });
  }
  /** Dry-run/apply disposition for one category; legal holds always block. Work records are anonymized, never silently deleted. */
  async applyRetention(actor: Principal, raw: unknown) {
    const input = parse(z.strictObject({ category: z.enum(['ATTENDANCE_EVIDENCE']), dryRun: z.boolean().default(true) }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'hr.retention.manage');
      const policy = await tx.suiteRetentionPolicy.findFirst({ where: { workspaceId: actor.workspaceId, module: 'hr', category: input.category, effectiveFrom: { lte: new Date() } }, orderBy: { effectiveFrom: 'desc' } });
      if (!policy) throw new AppError('POLICY_NOT_CONFIGURED', 'Retention policy for this category is required.', 409);
      const cutoff = new Date(Date.now() - policy.retentionDays * 86400000);
      const holds = await tx.suiteLegalHold.findMany({ where: { workspaceId: actor.workspaceId, module: 'hr', releasedAt: null } });
      if (holds.some(h => h.scopeType === 'WORKSPACE')) throw new AppError('INVALID_STATE_TRANSITION', 'A workspace legal hold blocks retention actions.', 409);
      const held = new Set(holds.map(h => h.scopeId).filter(Boolean) as string[]);
      const candidates = await tx.hrAttendanceEvidence.findMany({ where: { workspaceId: actor.workspaceId, createdAt: { lt: cutoff } }, select: { id: true, eventId: true } });
      const events = await tx.hrWorkEvent.findMany({ where: { id: { in: candidates.map(c => c.eventId) } }, select: { id: true, employeeId: true } });
      const disposable = candidates.filter(c => !held.has(events.find(e => e.id === c.eventId)?.employeeId ?? ''));
      if (!input.dryRun) await tx.hrAttendanceEvidence.deleteMany({ where: { id: { in: disposable.map(d => d.id) } } });
      await evidence(tx, actor, 'SUITE_RETENTION_POLICY', policy.id, input.dryRun ? 'HR_RETENTION_DRY_RUN' : 'HR_RETENTION_ACTION_APPLIED', { category: input.category, count: disposable.length, heldSkipped: candidates.length - disposable.length });
      return { dryRun: input.dryRun, category: input.category, eligible: disposable.length, blockedByLegalHold: candidates.length - disposable.length, cutoff: fromDate(cutoff) };
    });
  }
}
