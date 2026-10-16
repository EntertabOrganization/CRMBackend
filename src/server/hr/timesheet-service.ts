import type { HrEmployee, HrTimesheet, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors';
import { parse, uuid } from '../process-platform/dto';
import { evidence, lock, requirePermission, type Principal, type Tx } from '../process-platform/context';
import { asDate, dateRange, expectedVersion, fromDate, inTx, listQuery, localDate, notFound, paged, transition } from '../suite/kernel';
import { myEmployee, readableEmployee, teamAuthority } from './support';
import { HrWorktimeService } from './worktime-service';

const machine: Record<string, readonly string[]> = { DRAFT: ['SUBMITTED'], REJECTED: ['DRAFT', 'SUBMITTED'], SUBMITTED: ['APPROVED', 'REJECTED'], APPROVED: ['LOCKED'], LOCKED: ['REOPENED'], REOPENED: ['SUBMITTED'] };
const CRITICAL = ['INCOMPLETE_SESSION'];

/** Timesheets (HR/05) and overtime (HR/06). Task time never contributes to attendance totals. */
export class HrTimesheetService {
  constructor(private readonly db: PrismaClient) {}

  private async load(tx: Tx, actor: Principal, id: string) {
    const row = await tx.hrTimesheet.findFirst({ where: { workspaceId: actor.workspaceId, id: parse(uuid, id) } });
    if (!row) throw notFound('Timesheet');
    const employee = await tx.hrEmployee.findUniqueOrThrow({ where: { id: row.employeeId } });
    const self = employee.userId === actor.userId;
    const team = !self && (await teamAuthority(tx, actor, employee, 'hr.timesheet.approve_team') || actor.grants.has('hr.timesheet.reopen_hr'));
    if (!self && !team) throw notFound('Timesheet');
    return { row, employee, self, team };
  }
  private async lines(tx: Tx, employee: HrEmployee, from: string, to: string) {
    const days = await HrWorktimeService.attendanceDays(tx, employee, from, to);
    const overtime = await tx.hrOvertimeEntry.findMany({ where: { workspaceId: employee.workspaceId, employeeId: employee.id, workDate: { gte: asDate(from), lte: asDate(to) }, status: 'APPROVED' } });
    return days.map(d => ({ workDate: d.date, sourceSessionIds: d.sessionIds, scheduledMinutes: d.expectedMinutes, workedMinutes: d.workedMinutes, unpaidBreakMinutes: d.breakMinutes, leaveMinutes: d.leaveMinutes,
      overtimeMinutes: overtime.filter(o => fromDate(o.workDate) === d.date).reduce((s, o) => s + o.minutes, 0), anomalyCodes: d.status === 'ANOMALY' ? ['INCOMPLETE_SESSION'] : d.status === 'ABSENT' ? ['UNEXCUSED_ABSENCE'] : d.status === 'LATE' ? ['LATE'] : [] }));
  }
  async compile(actor: Principal, raw: unknown) {
    const input = parse(z.strictObject({ employeeId: uuid.optional(), periodStart: localDate, periodEnd: localDate }), raw);
    if (input.periodEnd < input.periodStart || dateRange(input.periodStart, input.periodEnd).length > 31) throw new AppError('VALIDATION_FAILED', 'Period must be 1–31 days.', 400);
    return inTx(this.db, actor, async (tx, actor) => {
      const employee = input.employeeId ? (await readableEmployee(tx, actor, input.employeeId)).employee : await myEmployee(tx, actor) as HrEmployee;
      if (employee.userId === actor.userId) requirePermission(actor, 'hr.timesheet.submit_self');
      else if (!await teamAuthority(tx, actor, employee, 'hr.timesheet.approve_team')) throw notFound('Employee');
      await lock(tx, actor.workspaceId, 'hr:timesheet:' + employee.id);
      const overlapping = await tx.hrTimesheet.findMany({ where: { workspaceId: actor.workspaceId, employeeId: employee.id, periodStart: { lte: asDate(input.periodEnd) }, periodEnd: { gte: asDate(input.periodStart) } } });
      const same = overlapping.find(t => fromDate(t.periodStart) === input.periodStart && fromDate(t.periodEnd) === input.periodEnd);
      if (overlapping.some(t => t !== same)) throw new AppError('TIMESHEET_OVERLAP', 'An overlapping timesheet exists for this employee.', 409);
      if (same && !['DRAFT', 'REJECTED', 'REOPENED'].includes(same.status)) throw new AppError('TIMESHEET_LOCKED', 'Timesheet is finalized; reopen it first.', 409);
      const lines = await this.lines(tx, employee, input.periodStart, input.periodEnd);
      const totals = { scheduledMinutes: lines.reduce((s, l) => s + l.scheduledMinutes, 0), workedMinutes: lines.reduce((s, l) => s + l.workedMinutes, 0), overtimeMinutes: lines.reduce((s, l) => s + l.overtimeMinutes, 0), leaveMinutes: lines.reduce((s, l) => s + l.leaveMinutes, 0), anomalies: lines.filter(l => l.anomalyCodes.length).length };
      const sheet = same ? await tx.hrTimesheet.update({ where: { id: same.id }, data: { totals, status: same.status === 'REJECTED' ? 'DRAFT' : same.status, version: { increment: 1 } } })
        : await tx.hrTimesheet.create({ data: { workspaceId: actor.workspaceId, employeeId: employee.id, periodStart: asDate(input.periodStart), periodEnd: asDate(input.periodEnd), timezone: employee.timezone, totals } });
      await tx.hrTimesheetLine.deleteMany({ where: { timesheetId: sheet.id } }); // draft lines are a rebuildable projection
      for (const l of lines) await tx.hrTimesheetLine.create({ data: { workspaceId: actor.workspaceId, timesheetId: sheet.id, ...l, workDate: asDate(l.workDate) } });
      await evidence(tx, actor, 'HR_TIMESHEET', sheet.id, 'TIMESHEET_COMPILED', { totals });
      return { ...sheet, lines };
    });
  }
  async list(actor: Principal, raw: unknown) {
    const q = parse(listQuery.extend({ employeeId: uuid.optional() }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      const rows = await tx.hrTimesheet.findMany({ where: { workspaceId: actor.workspaceId, ...(q.employeeId ? { employeeId: q.employeeId } : {}), ...(q.status ? { status: q.status } : {}) }, orderBy: [{ periodStart: 'desc' }, { id: 'asc' }], take: 1000 });
      const visible: HrTimesheet[] = [];
      for (const r of rows) try { await this.load(tx, actor, r.id); visible.push(r); } catch { /* scope */ }
      return paged(visible.slice((q.page - 1) * q.limit, q.page * q.limit), visible.length, q.page, q.limit);
    });
  }
  async get(actor: Principal, id: string) {
    return inTx(this.db, actor, async (tx, actor) => {
      const { row } = await this.load(tx, actor, id);
      const [lines, reviews] = await Promise.all([tx.hrTimesheetLine.findMany({ where: { timesheetId: row.id }, orderBy: { workDate: 'asc' } }), tx.hrTimesheetReview.findMany({ where: { timesheetId: row.id }, orderBy: { occurredAt: 'asc' } })]);
      return { ...row, lines, reviews };
    });
  }
  /** Direct edits of derived totals are never allowed; finalized periods return 409. */
  async patch(actor: Principal, id: string) {
    return inTx(this.db, actor, async (tx, actor) => {
      const { row } = await this.load(tx, actor, id);
      if (['SUBMITTED', 'APPROVED', 'LOCKED'].includes(row.status)) throw new AppError('TIMESHEET_LOCKED', 'Timesheet is finalized; an authorized reopen is required.', 409);
      throw new AppError('VALIDATION_FAILED', 'Timesheet values are derived from work events; submit an attendance correction instead.', 400);
    });
  }
  async submit(actor: Principal, id: string, raw: unknown) {
    const input = parse(z.strictObject({ expectedVersion }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      await lock(tx, actor.workspaceId, 'hr:timesheet-row:' + id);
      const { row, self } = await this.load(tx, actor, id);
      if (!self) throw new AppError('PERMISSION_DENIED', 'Employees submit their own timesheets.', 403);
      requirePermission(actor, 'hr.timesheet.submit_self');
      if (row.status === 'SUBMITTED' && row.version === input.expectedVersion + 1) return row; // repeated submit of the same version
      if (row.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT', 'Timesheet changed; reload.', 409);
      transition(machine, row.status, 'SUBMITTED');
      const lines = await tx.hrTimesheetLine.findMany({ where: { timesheetId: row.id } });
      if (lines.some(l => (l.anomalyCodes as string[]).some(c => CRITICAL.includes(c)))) throw new AppError('INVALID_STATE_TRANSITION', 'Resolve critical attendance anomalies before submitting.', 409);
      const updated = await tx.hrTimesheet.update({ where: { id: row.id }, data: { status: 'SUBMITTED', submittedAt: new Date(), version: { increment: 1 } } });
      await tx.hrTimesheetReview.upsert({ where: { timesheetId_revision_decision: { timesheetId: row.id, revision: row.revision, decision: 'SUBMITTED' } }, create: { workspaceId: actor.workspaceId, timesheetId: row.id, revision: row.revision, actorUserId: actor.userId, decision: 'SUBMITTED' }, update: {} });
      await evidence(tx, actor, 'HR_TIMESHEET', row.id, 'TIMESHEET_SUBMITTED', { revision: row.revision });
      return updated;
    });
  }
  async review(actor: Principal, id: string, raw: unknown, decision: 'APPROVED' | 'REJECTED' | 'LOCKED' | 'REOPENED') {
    const input = parse(z.strictObject({ expectedVersion, comment: z.string().trim().max(1000).optional(), reason: z.string().trim().min(1).max(1000).optional() }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      await lock(tx, actor.workspaceId, 'hr:timesheet-row:' + id);
      const { row, employee, self } = await this.load(tx, actor, id);
      if (self) throw new AppError('PERMISSION_DENIED', 'Self-approval is not permitted.', 403);
      if (decision === 'REOPENED') { requirePermission(actor, 'hr.timesheet.reopen_hr'); if (!input.reason) throw new AppError('VALIDATION_FAILED', 'Reopen requires a reason.', 400, { fields: [{ field: 'reason', reason: 'REQUIRED' }] }); }
      else if (!await teamAuthority(tx, actor, employee, 'hr.timesheet.approve_team')) throw new AppError('PERMISSION_DENIED', 'Not authorized to review this timesheet.', 403);
      if (row.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT', 'Timesheet changed; reload.', 409);
      transition(machine, row.status, decision);
      const lines = decision === 'LOCKED' ? await tx.hrTimesheetLine.findMany({ where: { timesheetId: row.id } }) : [];
      const updated = await tx.hrTimesheet.update({ where: { id: row.id }, data: { status: decision, version: { increment: 1 }, ...(decision === 'APPROVED' ? { approvedAt: new Date() } : {}),
        ...(decision === 'LOCKED' ? { lockedAt: new Date(), policyVersions: { attendance: 1, overtime: 'APPROVED_ENTRIES', lineCount: lines.length } } : {}), ...(decision === 'REOPENED' ? { revision: { increment: 1 }, lockedAt: null } : {}) } });
      await tx.hrTimesheetReview.create({ data: { workspaceId: actor.workspaceId, timesheetId: row.id, revision: row.revision, actorUserId: actor.userId, decision, comment: input.comment ?? input.reason } });
      await evidence(tx, actor, 'HR_TIMESHEET', row.id, 'TIMESHEET_' + decision, { revision: row.revision });
      return updated;
    });
  }

  // ------------------------------------------------------------------ overtime
  async policy(actor: Principal, raw: unknown) {
    const input = parse(z.strictObject({ workLocationId: uuid.optional(), thresholds: z.strictObject({ dailyMinutes: z.number().int().min(1).max(1440).optional(), weeklyMinutes: z.number().int().min(1).max(10080).optional(), holidayAllMinutes: z.boolean().default(false) })
      .refine(t => t.dailyMinutes || t.weeklyMinutes || t.holidayAllMinutes, 'At least one threshold is required'), eligibleEmploymentTypes: z.array(z.string()).min(1), countLeaveAsWorked: z.boolean().default(false), effectiveFrom: localDate }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'hr.overtime.policy.manage');
      const row = await tx.hrOvertimePolicy.create({ data: { workspaceId: actor.workspaceId, ...input, effectiveFrom: asDate(input.effectiveFrom) } });
      await evidence(tx, actor, 'HR_OVERTIME_POLICY', row.id, 'OVERTIME_POLICY_CHANGED', { thresholds: input.thresholds });
      return row;
    });
  }
  /** Daily threshold first, then weekly excess not already counted daily (no double counting); minutes and tags only, never pay. */
  async recalculate(actor: Principal, raw: unknown) {
    const input = parse(z.strictObject({ employeeId: uuid, from: localDate, to: localDate }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      const { employee } = await readableEmployee(tx, actor, input.employeeId);
      if (!await teamAuthority(tx, actor, employee, 'hr.overtime.approve_team') && !actor.grants.has('hr.overtime.policy.manage')) throw notFound('Employee');
      const policy = await tx.hrOvertimePolicy.findFirst({ where: { workspaceId: actor.workspaceId, effectiveFrom: { lte: asDate(input.to) }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: asDate(input.from) } }], AND: [{ OR: [{ workLocationId: null }, { workLocationId: employee.workLocationId ?? undefined }] }] }, orderBy: { effectiveFrom: 'desc' } });
      const days = await HrWorktimeService.attendanceDays(tx, employee, input.from, input.to);
      if (!policy || !(policy.eligibleEmploymentTypes as string[]).includes(employee.employmentType)) {
        // Missing policy: report unclassified excess; never auto-approve or create overtime.
        return { policy: null, unclassifiedExcess: days.map(d => ({ date: d.date, minutes: Math.max(0, d.workedMinutes - d.expectedMinutes) })).filter(d => d.minutes > 0), payroll: 'NOT_CALCULATED' };
      }
      const t = policy.thresholds as { dailyMinutes?: number; weeklyMinutes?: number; holidayAllMinutes?: boolean };
      const locked = await tx.hrTimesheet.findMany({ where: { workspaceId: actor.workspaceId, employeeId: employee.id, status: { in: ['APPROVED', 'LOCKED'] } } });
      const isLocked = (d: string) => locked.some(s => fromDate(s.periodStart) <= d && fromDate(s.periodEnd) >= d);
      const daily = new Map<string, number>(); const results: { periodKey: string; rule: string; minutes: number; workDate: string }[] = [];
      const holidays = new Set((await tx.hrScheduleVersion.findMany({ where: { id: { in: (await tx.hrScheduleAssignment.findMany({ where: { employeeId: employee.id } })).map(a => a.scheduleVersionId) } } })).flatMap(v => ((v.rules as { holidays?: string[] }).holidays ?? [])));
      for (const d of days) {
        const worked = d.workedMinutes + (policy.countLeaveAsWorked ? d.leaveMinutes : 0);
        let minutes = 0, rule = 'DAILY';
        if (t.holidayAllMinutes && holidays.has(d.date)) { minutes = worked; rule = 'HOLIDAY'; }
        else if (t.dailyMinutes) minutes = Math.max(0, worked - t.dailyMinutes);
        daily.set(d.date, minutes); if (minutes > 0) results.push({ periodKey: d.date, rule, minutes, workDate: d.date });
      }
      if (t.weeklyMinutes) {
        const weeks = new Map<string, typeof days>();
        for (const d of days) { const dt = new Date(d.date + 'T00:00:00Z'), monday = new Date(dt.getTime() - ((dt.getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10); weeks.set(monday, [...(weeks.get(monday) ?? []), d]); }
        for (const [monday, list] of weeks) {
          const worked = list.reduce((s, d) => s + d.workedMinutes + (policy.countLeaveAsWorked ? d.leaveMinutes : 0), 0), alreadyDaily = list.reduce((s, d) => s + (daily.get(d.date) ?? 0), 0);
          const excess = Math.max(0, worked - t.weeklyMinutes - alreadyDaily);
          if (excess > 0) results.push({ periodKey: 'W' + monday, rule: 'WEEKLY', minutes: excess, workDate: list[list.length - 1].date });
        }
      }
      const saved = [];
      for (const r of results) {
        if (isLocked(r.workDate)) continue;
        const key = { workspaceId_employeeId_periodKey_rule: { workspaceId: actor.workspaceId, employeeId: employee.id, periodKey: r.periodKey, rule: r.rule } };
        const prior = await tx.hrOvertimeEntry.findUnique({ where: key });
        if (prior && prior.minutes === r.minutes) { saved.push(prior); continue; }
        saved.push(prior ? await tx.hrOvertimeEntry.update({ where: { id: prior.id }, data: { minutes: r.minutes, policyId: policy.id, policyVersion: policy.version, status: 'CALCULATED', version: { increment: 1 } } })
          : await tx.hrOvertimeEntry.create({ data: { workspaceId: actor.workspaceId, employeeId: employee.id, workDate: asDate(r.workDate), periodKey: r.periodKey, rule: r.rule, minutes: r.minutes, policyId: policy.id, policyVersion: policy.version } }));
      }
      await evidence(tx, actor, 'HR_EMPLOYEE', employee.id, 'OVERTIME_CALCULATED', { entries: saved.length, policyVersion: policy.version });
      return { policyId: policy.id, entries: saved, payroll: 'NOT_CALCULATED' };
    });
  }
  async overtime(actor: Principal, raw: unknown) {
    const q = parse(z.object({ employeeId: uuid.optional(), status: z.string().optional() }).passthrough(), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      const rows = await tx.hrOvertimeEntry.findMany({ where: { workspaceId: actor.workspaceId, ...(q.employeeId ? { employeeId: q.employeeId } : {}), ...(q.status ? { status: q.status } : {}) }, orderBy: { workDate: 'desc' }, take: 1000 });
      const out = [];
      for (const r of rows) { const e = await tx.hrEmployee.findUniqueOrThrow({ where: { id: r.employeeId } }); if (e.userId === actor.userId || await teamAuthority(tx, actor, e, 'hr.overtime.approve_team')) out.push(r); }
      return out;
    });
  }
  async overtimeDecision(actor: Principal, id: string, raw: unknown, decision: 'REQUESTED' | 'APPROVED' | 'REJECTED') {
    const input = parse(z.strictObject({ expectedVersion, comment: z.string().trim().max(1000).optional() }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      await lock(tx, actor.workspaceId, 'hr:overtime:' + id);
      const row = await tx.hrOvertimeEntry.findFirst({ where: { workspaceId: actor.workspaceId, id: parse(uuid, id) } });
      if (!row) throw notFound('Overtime entry');
      const employee = await tx.hrEmployee.findUniqueOrThrow({ where: { id: row.employeeId } });
      if (decision === 'REQUESTED') { if (employee.userId !== actor.userId) throw notFound('Overtime entry'); requirePermission(actor, 'hr.overtime.request_self'); }
      else if (!await teamAuthority(tx, actor, employee, 'hr.overtime.approve_team')) throw new AppError('PERMISSION_DENIED', 'Not authorized to decide overtime for this employee.', 403);
      if (row.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT', 'Overtime entry changed; reload.', 409);
      transition({ CALCULATED: ['REQUESTED'], REQUESTED: ['APPROVED', 'REJECTED'] }, row.status, decision);
      if (await tx.hrTimesheet.findFirst({ where: { workspaceId: actor.workspaceId, employeeId: employee.id, status: 'LOCKED', periodStart: { lte: row.workDate }, periodEnd: { gte: row.workDate } } })) throw new AppError('TIMESHEET_LOCKED', 'Locked period; reopen first.', 409);
      const updated = await tx.hrOvertimeEntry.update({ where: { id: row.id }, data: { status: decision, version: { increment: 1 } } });
      if (decision !== 'REQUESTED') await tx.hrOvertimeApproval.create({ data: { workspaceId: actor.workspaceId, entryId: row.id, entryVersion: row.version, reviewerUserId: actor.userId, decision, comment: input.comment } });
      await evidence(tx, actor, 'HR_OVERTIME', row.id, decision === 'REQUESTED' ? 'OVERTIME_REQUESTED' : 'OVERTIME_' + decision, { minutes: row.minutes });
      return updated;
    });
  }
}
