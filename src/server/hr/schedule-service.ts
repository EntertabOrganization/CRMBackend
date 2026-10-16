import type { HrEmployee, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors';
import { parse, uuid } from '../process-platform/dto';
import { evidence, lock, requirePermission, type Principal, type Tx } from '../process-platform/context';
import { addLocalDays, asDate, dateRange, fromDate, ianaZone, inTx, localDate, notFound, weekday, zonedInstant } from '../suite/kernel';
import { readableEmployee, teamAuthority, visibleDepartments } from './support';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const scheduleRules = z.strictObject({
  windows: z.partialRecord(z.enum(['0', '1', '2', '3', '4', '5', '6']), z.array(z.strictObject({ start: hhmm, end: hhmm })).max(4)).default({}),
  unpaidBreakMinutes: z.number().int().min(0).max(480).default(0), paidBreakMinutes: z.number().int().min(0).max(480).default(0),
  restDays: z.array(z.number().int().min(0).max(6)).max(7).default([]), holidays: z.array(localDate).max(400).default([]),
  // DST: a wall time that does not exist (spring gap) shifts forward; an ambiguous one (fall overlap) uses the first instant.
  dstPolicy: z.literal('SHIFT_FORWARD_FIRST_OCCURRENCE').default('SHIFT_FORWARD_FIRST_OCCURRENCE'),
});
export type ExpectedPeriod = { date: string; startAt: Date; endAt: Date; minutes: number; source: 'SCHEDULE' | 'SHIFT'; holiday: boolean };

/** Effective-dated schedules, versions, assignments, shifts and expected work periods (spec HR/02). */
export class HrScheduleService {
  constructor(private readonly db: PrismaClient) {}

  async location(actor: Principal, raw: unknown) {
    const input = parse(z.strictObject({ name: z.string().trim().min(1).max(160), timezone: ianaZone, allowedNetworks: z.array(z.string().regex(/^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/)).max(50).default([]),
      geoRules: z.strictObject({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), radiusMeters: z.number().int().min(10).max(50000) }).optional(), qrRequired: z.boolean().default(false), qrSecretRef: z.string().regex(/^env:[A-Z][A-Z0-9_]{1,80}$/).optional() }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'hr.schedule.manage');
      if (input.qrRequired && !input.qrSecretRef) throw new AppError('POLICY_NOT_CONFIGURED', 'QR attendance requires a QR secret reference.', 409);
      const row = await tx.hrWorkLocation.create({ data: { workspaceId: actor.workspaceId, ...input, geoRules: input.geoRules ?? undefined } });
      await evidence(tx, actor, 'HR_WORK_LOCATION', row.id, 'WORK_LOCATION_CREATED', { evidencePolicy: { network: input.allowedNetworks.length > 0, gps: Boolean(input.geoRules), qr: input.qrRequired } });
      return row;
    });
  }
  async create(actor: Principal, raw: unknown) {
    const input = parse(z.strictObject({ name: z.string().trim().min(1).max(160), type: z.enum(['FIXED', 'FLEXIBLE', 'SHIFT']), timezone: ianaZone }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'hr.schedule.manage');
      const row = await tx.hrSchedule.create({ data: { workspaceId: actor.workspaceId, ...input } });
      await evidence(tx, actor, 'HR_SCHEDULE', row.id, 'SCHEDULE_CREATED', { type: row.type }); return row;
    });
  }
  async list(actor: Principal) {
    return inTx(this.db, actor, async (tx, actor) => {
      if (!actor.grants.has('hr.schedule.read')) requirePermission(actor, 'hr.schedule.manage');
      const schedules = await tx.hrSchedule.findMany({ where: { workspaceId: actor.workspaceId }, orderBy: { name: 'asc' } });
      const versions = await tx.hrScheduleVersion.findMany({ where: { workspaceId: actor.workspaceId, scheduleId: { in: schedules.map(s => s.id) } }, orderBy: [{ scheduleId: 'asc' }, { versionNo: 'asc' }] });
      return schedules.map(s => ({ ...s, versions: versions.filter(v => v.scheduleId === s.id) }));
    });
  }
  /** Future-dated version; overlapping effective ranges are rejected; finalized history is never rewritten. */
  async addVersion(actor: Principal, scheduleId: string, raw: unknown) {
    const input = parse(z.strictObject({ effectiveFrom: localDate, effectiveTo: localDate.optional(), rules: scheduleRules }), raw);
    if (input.effectiveTo && input.effectiveTo < input.effectiveFrom) throw new AppError('VALIDATION_FAILED', 'effectiveTo precedes effectiveFrom.', 400);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'hr.schedule.manage'); await lock(tx, actor.workspaceId, 'hr:schedule:' + scheduleId);
      const schedule = await tx.hrSchedule.findFirst({ where: { workspaceId: actor.workspaceId, id: parse(uuid, scheduleId) } });
      if (!schedule) throw notFound('Schedule');
      for (const windows of Object.values(input.rules.windows)) for (const w of windows ?? []) if (w.start === w.end) throw new AppError('VALIDATION_FAILED', 'Window start and end must differ.', 400);
      const versions = await tx.hrScheduleVersion.findMany({ where: { scheduleId, status: { not: 'SUPERSEDED' } } });
      const from = input.effectiveFrom, to = input.effectiveTo ?? '9999-12-31';
      if (versions.some(v => fromDate(v.effectiveFrom) <= to && (v.effectiveTo ? fromDate(v.effectiveTo) : '9999-12-31') >= from)) {
        // An open-ended current version is closed the day before the new one, when that does not rewrite the past.
        const open = versions.find(v => !v.effectiveTo && fromDate(v.effectiveFrom) < from);
        const conflicting = versions.filter(v => v !== open && fromDate(v.effectiveFrom) <= to && (v.effectiveTo ? fromDate(v.effectiveTo) : '9999-12-31') >= from);
        if (conflicting.length || !open) throw new AppError('SCHEDULE_VERSION_OVERLAP', 'Effective dates overlap an existing schedule version.', 409);
        if (from <= new Date().toISOString().slice(0, 10) && await tx.hrTimesheet.count({ where: { workspaceId: actor.workspaceId, status: { in: ['APPROVED', 'LOCKED'] }, periodEnd: { gte: asDate(from) } } }))
          throw new AppError('INVALID_STATE_TRANSITION', 'Retroactive change would affect finalized timesheets.', 409);
        await tx.hrScheduleVersion.update({ where: { id: open.id }, data: { effectiveTo: asDate(addLocalDays(from, -1)) } });
      }
      const last = await tx.hrScheduleVersion.findFirst({ where: { scheduleId }, orderBy: { versionNo: 'desc' } });
      const row = await tx.hrScheduleVersion.create({ data: { workspaceId: actor.workspaceId, scheduleId, versionNo: (last?.versionNo ?? 0) + 1, effectiveFrom: asDate(from), effectiveTo: input.effectiveTo ? asDate(input.effectiveTo) : null, rules: input.rules } });
      await evidence(tx, actor, 'HR_SCHEDULE', scheduleId, 'SCHEDULE_VERSION_PUBLISHED', { versionNo: row.versionNo, effectiveFrom: from });
      return row;
    });
  }
  async assign(actor: Principal, employeeId: string, raw: unknown) {
    const input = parse(z.strictObject({ scheduleVersionId: uuid, effectiveFrom: localDate, effectiveTo: localDate.optional() }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'hr.schedule.manage'); await lock(tx, actor.workspaceId, 'hr:assignments:' + employeeId);
      const employee = await tx.hrEmployee.findFirst({ where: { workspaceId: actor.workspaceId, id: parse(uuid, employeeId) } });
      if (!employee) throw notFound('Employee');
      if (actor.grants.get('hr.schedule.manage') !== 'WORKSPACE' && !await teamAuthority(tx, actor, employee, 'hr.schedule.manage')) throw notFound('Employee');
      const version = await tx.hrScheduleVersion.findFirst({ where: { workspaceId: actor.workspaceId, id: input.scheduleVersionId } });
      if (!version) throw notFound('Schedule version');
      const to = input.effectiveTo ?? '9999-12-31';
      const existing = await tx.hrScheduleAssignment.findMany({ where: { workspaceId: actor.workspaceId, employeeId } });
      if (existing.some(a => fromDate(a.effectiveFrom) <= to && (a.effectiveTo ? fromDate(a.effectiveTo) : '9999-12-31') >= input.effectiveFrom)) throw new AppError('SCHEDULE_ASSIGNMENT_OVERLAP', 'Employee already has a schedule for part of this period.', 409);
      const row = await tx.hrScheduleAssignment.create({ data: { workspaceId: actor.workspaceId, employeeId, scheduleVersionId: version.id, effectiveFrom: asDate(input.effectiveFrom), effectiveTo: input.effectiveTo ? asDate(input.effectiveTo) : null } });
      await evidence(tx, actor, 'HR_EMPLOYEE', employeeId, 'EMPLOYEE_SCHEDULE_CHANGED', { assignmentId: row.id, scheduleVersionId: version.id });
      return row;
    });
  }
  async createShift(actor: Principal, raw: unknown) {
    const input = parse(z.strictObject({ startAt: z.iso.datetime({ offset: true }), endAt: z.iso.datetime({ offset: true }), capacity: z.number().int().min(1).max(1000), locationId: uuid.optional(), departmentId: uuid.optional(), scheduleVersionId: uuid.optional() }), raw);
    if (new Date(input.endAt) <= new Date(input.startAt) || new Date(input.endAt).getTime() - new Date(input.startAt).getTime() > 24 * 3600000) throw new AppError('VALIDATION_FAILED', 'Shift must end after it starts and last at most 24h.', 400);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'hr.shift.manage');
      if (input.departmentId && actor.grants.get('hr.shift.manage') !== 'WORKSPACE' && !(await visibleDepartments(tx, actor, 'hr.shift.manage')).has(input.departmentId)) throw notFound('Department');
      if (input.locationId && !await tx.hrWorkLocation.findFirst({ where: { workspaceId: actor.workspaceId, id: input.locationId } })) throw notFound('Location');
      const row = await tx.hrShift.create({ data: { workspaceId: actor.workspaceId, startAt: new Date(input.startAt), endAt: new Date(input.endAt), capacity: input.capacity, locationId: input.locationId, departmentId: input.departmentId, scheduleVersionId: input.scheduleVersionId } });
      await evidence(tx, actor, 'HR_SHIFT', row.id, 'SHIFT_PUBLISHED', {}); return row;
    });
  }
  async assignShift(actor: Principal, shiftId: string, raw: unknown) {
    const input = parse(z.strictObject({ employeeId: uuid }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'hr.shift.manage'); await lock(tx, actor.workspaceId, 'hr:shift:' + shiftId);
      const shift = await tx.hrShift.findFirst({ where: { workspaceId: actor.workspaceId, id: parse(uuid, shiftId) } });
      const employee = await tx.hrEmployee.findFirst({ where: { workspaceId: actor.workspaceId, id: input.employeeId, status: { in: ['ACTIVE', 'INVITED'] } } });
      if (!shift || !employee) throw notFound('Shift or employee');
      if (shift.status !== 'PUBLISHED') throw new AppError('INVALID_STATE_TRANSITION', 'Shift is not open for assignment.', 409);
      if (actor.grants.get('hr.shift.manage') !== 'WORKSPACE' && !await teamAuthority(tx, actor, employee, 'hr.shift.manage')) throw notFound('Employee');
      if (shift.locationId && employee.workLocationId && shift.locationId !== employee.workLocationId) throw new AppError('INVALID_STATE_TRANSITION', 'Employee is not eligible for this location.', 409);
      if (await tx.hrShiftAssignment.count({ where: { shiftId: shift.id, status: 'ASSIGNED' } }) >= shift.capacity) throw new AppError('INVALID_STATE_TRANSITION', 'Shift capacity reached.', 409);
      const clash = await tx.hrShiftAssignment.findMany({ where: { workspaceId: actor.workspaceId, employeeId: employee.id, status: 'ASSIGNED' } });
      for (const c of clash) { const other = await tx.hrShift.findUnique({ where: { id: c.shiftId } }); if (other && other.startAt < shift.endAt && other.endAt > shift.startAt) throw new AppError('SCHEDULE_ASSIGNMENT_OVERLAP', 'Employee has an overlapping shift.', 409); }
      const row = await tx.hrShiftAssignment.create({ data: { workspaceId: actor.workspaceId, shiftId: shift.id, employeeId: employee.id } });
      await evidence(tx, actor, 'HR_SHIFT', shift.id, 'SHIFT_ASSIGNED', { employeeId: employee.id }); return row;
    });
  }
  async expectedWorkdays(actor: Principal, employeeId: string, raw: unknown) {
    const q = parse(z.object({ from: localDate, to: localDate }).passthrough(), raw);
    if (dateRange(q.from, q.to).length > 93) throw new AppError('VALIDATION_FAILED', 'Range is limited to 93 days.', 400);
    return inTx(this.db, actor, async (tx, actor) => {
      const { employee } = await readableEmployee(tx, actor, parse(uuid, employeeId));
      return (await HrScheduleService.expected(tx, employee, q.from, q.to)).map(p => ({ ...p, startAt: p.startAt.toISOString(), endAt: p.endAt.toISOString() }));
    });
  }

  /** Expected periods per local date. Overnight windows (end <= start) belong to the start date and end on D+1. */
  static async expected(tx: Tx, employee: HrEmployee, from: string, to: string): Promise<ExpectedPeriod[]> {
    const assignments = await tx.hrScheduleAssignment.findMany({ where: { workspaceId: employee.workspaceId, employeeId: employee.id, effectiveFrom: { lte: asDate(to) }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: asDate(from) } }] } });
    const versions = await tx.hrScheduleVersion.findMany({ where: { id: { in: assignments.map(a => a.scheduleVersionId) } } });
    const schedules = await tx.hrSchedule.findMany({ where: { id: { in: versions.map(v => v.scheduleId) } } });
    const out: ExpectedPeriod[] = [];
    for (const date of dateRange(from, to)) {
      const assignment = assignments.find(a => fromDate(a.effectiveFrom) <= date && (!a.effectiveTo || fromDate(a.effectiveTo) >= date));
      if (!assignment) continue;
      const version = versions.find(v => v.id === assignment.scheduleVersionId)!, schedule = schedules.find(s => s.id === version.scheduleId)!;
      const rules = scheduleRules.parse(version.rules), holiday = rules.holidays.includes(date);
      if (schedule.type === 'SHIFT') continue;
      if (rules.restDays.includes(weekday(date))) continue;
      for (const w of rules.windows[String(weekday(date)) as '0'] ?? []) {
        const startAt = zonedInstant(date, w.start, schedule.timezone), endAt = zonedInstant(w.end <= w.start ? addLocalDays(date, 1) : date, w.end, schedule.timezone);
        const minutes = holiday ? 0 : Math.max(0, Math.round((endAt.getTime() - startAt.getTime()) / 60000) - rules.unpaidBreakMinutes);
        out.push({ date, startAt, endAt, minutes, source: 'SCHEDULE', holiday });
      }
    }
    const shifts = await tx.hrShiftAssignment.findMany({ where: { workspaceId: employee.workspaceId, employeeId: employee.id, status: 'ASSIGNED' } });
    for (const s of await tx.hrShift.findMany({ where: { id: { in: shifts.map(x => x.shiftId) }, status: { not: 'CANCELLED' } } })) {
      const local = new Intl.DateTimeFormat('en-CA', { timeZone: employee.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(s.startAt);
      if (local >= from && local <= to) out.push({ date: local, startAt: s.startAt, endAt: s.endAt, minutes: Math.round((s.endAt.getTime() - s.startAt.getTime()) / 60000), source: 'SHIFT', holiday: false });
    }
    return out.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
  }
  static async holidays(tx: Tx, employee: HrEmployee, from: string, to: string) {
    const assignments = await tx.hrScheduleAssignment.findMany({ where: { workspaceId: employee.workspaceId, employeeId: employee.id } });
    const versions = await tx.hrScheduleVersion.findMany({ where: { id: { in: assignments.map(a => a.scheduleVersionId) } } });
    return new Set(versions.flatMap(v => scheduleRules.parse(v.rules).holidays).filter(d => d >= from && d <= to));
  }
}
