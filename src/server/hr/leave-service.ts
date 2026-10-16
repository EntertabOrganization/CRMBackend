import { Prisma, type HrEmployee, type HrLeaveRequest, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors';
import { decimal, parse, uuid } from '../process-platform/dto';
import { evidence, lock, requirePermission, type Principal, type Tx } from '../process-platform/context';
import { asDate, dateRange, decrypt, encrypt, expectedVersion, fromDate, ianaZone, inTx, localDate, notFound, policyMissing } from '../suite/kernel';
import { myEmployee, readableEmployee, teamAuthority, visibleDepartments } from './support';
import { HrScheduleService } from './schedule-service';

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const APPROVER_STEPS = ['MANAGER', 'DEPARTMENT', 'HR'] as const;

/** Leave types, policy-versioned append-only ledger, requests, approval chain and free/busy projection (HR/07, HR/08). */
export class HrLeaveService {
  constructor(private readonly db: PrismaClient) {}

  async createType(actor: Principal, raw: unknown) {
    const input = parse(z.strictObject({ name: z.string().trim().min(1).max(120), unit: z.enum(['DAY', 'HOUR']), paid: z.boolean(), requiresBalance: z.boolean(), approvalChain: z.array(z.enum(APPROVER_STEPS)).min(1).max(3).default(['MANAGER']) }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'hr.leave.policy.manage');
      const row = await tx.hrLeaveType.create({ data: { workspaceId: actor.workspaceId, ...input } });
      await evidence(tx, actor, 'HR_LEAVE_TYPE', row.id, 'LEAVE_TYPE_CREATED', { unit: row.unit, paid: row.paid }); return row;
    });
  }
  async createPolicy(actor: Principal, raw: unknown) {
    const input = parse(z.strictObject({ leaveTypeId: uuid, locationId: uuid.optional(), accrualRule: z.strictObject({ frequency: z.enum(['MONTHLY', 'YEARLY', 'NONE']), units: decimal, prorateFromStart: z.boolean().default(true) }),
      carryOverRule: z.strictObject({ maxUnits: decimal.default('0'), expiresAfterDays: z.number().int().min(0).max(3650).optional() }), negativeAllowed: z.boolean().default(false), holidays: z.array(localDate).max(400).default([]), leadTimeDays: z.number().int().min(0).max(365).default(0), effectiveFrom: localDate }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'hr.leave.policy.manage');
      if (!await tx.hrLeaveType.findFirst({ where: { workspaceId: actor.workspaceId, id: input.leaveTypeId } })) throw notFound('Leave type');
      if (input.locationId && !await tx.hrWorkLocation.findFirst({ where: { workspaceId: actor.workspaceId, id: input.locationId } })) throw notFound('Location');
      const prior = await tx.hrLeavePolicy.findFirst({ where: { workspaceId: actor.workspaceId, leaveTypeId: input.leaveTypeId, locationId: input.locationId ?? null, effectiveTo: null }, orderBy: { effectiveFrom: 'desc' } });
      if (prior && fromDate(prior.effectiveFrom) >= input.effectiveFrom) throw new AppError('INVALID_STATE_TRANSITION', 'New policy versions must start after the current one.', 409);
      if (prior) await tx.hrLeavePolicy.update({ where: { id: prior.id }, data: { effectiveTo: asDate(input.effectiveFrom) } });
      const row = await tx.hrLeavePolicy.create({ data: { workspaceId: actor.workspaceId, ...input, effectiveFrom: asDate(input.effectiveFrom), version: (prior?.version ?? 0) + 1 } });
      await evidence(tx, actor, 'HR_LEAVE_POLICY', row.id, 'LEAVE_POLICY_CHANGED', { leaveTypeId: row.leaveTypeId, version: row.version });
      return row;
    });
  }
  private async policy(tx: Tx, employee: HrEmployee, leaveTypeId: string, onDate: string) {
    return tx.hrLeavePolicy.findFirst({ where: { workspaceId: employee.workspaceId, leaveTypeId, effectiveFrom: { lte: asDate(onDate) }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: asDate(onDate) } }],
      AND: [{ OR: [{ locationId: null }, ...(employee.workLocationId ? [{ locationId: employee.workLocationId }] : [])] }] }, orderBy: [{ locationId: 'desc' }, { effectiveFrom: 'desc' }] });
  }
  private async account(tx: Tx, employee: HrEmployee, leaveTypeId: string, unit: string, period: string) {
    return tx.hrLeaveAccount.upsert({ where: { workspaceId_employeeId_leaveTypeId_period: { workspaceId: employee.workspaceId, employeeId: employee.id, leaveTypeId, period } }, create: { workspaceId: employee.workspaceId, employeeId: employee.id, leaveTypeId, period, unit }, update: {} });
  }
  /** Available = accrual + allocation + adjustments − debits − active holds (derived from the ledger, never overwritten). */
  static async balance(tx: Tx, accountId: string) {
    const rows = await tx.hrLeaveLedger.findMany({ where: { accountId } });
    let granted = D(0), used = D(0), held = D(0);
    for (const r of rows) {
      if (['ACCRUAL', 'ALLOCATION', 'ADJUSTMENT', 'CARRY_OVER'].includes(r.kind)) granted = granted.plus(r.units);
      if (r.kind === 'DEBIT') used = used.plus(r.units);
      if (r.kind === 'REQUEST_HOLD' && r.active) held = held.plus(r.units);
    }
    return { granted: granted.toFixed(4), used: used.toFixed(4), held: held.toFixed(4), available: granted.minus(used).minus(held).toFixed(4) };
  }
  async balances(actor: Principal, employeeId: string | null) {
    return inTx(this.db, actor, async (tx, actor) => {
      const employee = employeeId ? (await readableEmployee(tx, actor, parse(uuid, employeeId))).employee : await myEmployee(tx, actor) as HrEmployee;
      if (employeeId && employee.userId !== actor.userId && !await teamAuthority(tx, actor, employee, 'hr.leave.approve_team') && !actor.grants.has('hr.leave.balance.override')) throw notFound('Employee');
      const accounts = await tx.hrLeaveAccount.findMany({ where: { workspaceId: actor.workspaceId, employeeId: employee.id } });
      const types = await tx.hrLeaveType.findMany({ where: { workspaceId: actor.workspaceId, id: { in: accounts.map(a => a.leaveTypeId) } } });
      return Promise.all(accounts.map(async a => ({ accountId: a.id, leaveTypeId: a.leaveTypeId, leaveType: types.find(t => t.id === a.leaveTypeId)?.name, period: a.period, unit: a.unit, ...(await HrLeaveService.balance(tx, a.id)) })));
    });
  }
  async adjust(actor: Principal, raw: unknown, key: string | null) {
    const input = parse(z.strictObject({ employeeId: uuid, leaveTypeId: uuid, period: z.string().regex(/^\d{4}$/), units: z.string().regex(/^-?\d{1,6}(?:\.\d{1,4})?$/), kind: z.enum(['ALLOCATION', 'ADJUSTMENT']), note: z.string().trim().min(1).max(500) }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'hr.leave.balance.override');
      const employee = await tx.hrEmployee.findFirst({ where: { workspaceId: actor.workspaceId, id: input.employeeId } });
      const type = await tx.hrLeaveType.findFirst({ where: { workspaceId: actor.workspaceId, id: input.leaveTypeId } });
      if (!employee || !type) throw notFound('Employee or leave type');
      const account = await this.account(tx, employee, type.id, type.unit, input.period);
      await lock(tx, actor.workspaceId, 'hr:leave-account:' + account.id);
      const idem = key ?? 'adjust:' + input.employeeId + ':' + input.note + ':' + input.units;
      const prior = await tx.hrLeaveLedger.findUnique({ where: { accountId_idempotencyKey: { accountId: account.id, idempotencyKey: idem } } });
      if (prior) return prior;
      const row = await tx.hrLeaveLedger.create({ data: { workspaceId: actor.workspaceId, accountId: account.id, employeeId: employee.id, kind: input.kind, units: input.units, idempotencyKey: idem, note: input.note, createdByUserId: actor.userId } });
      await evidence(tx, actor, 'HR_LEAVE_ACCOUNT', account.id, 'LEAVE_BALANCE_ADJUSTED', { units: input.units, kind: input.kind });
      return row;
    });
  }
  /** Accrual per the effective policy; missing policy is a configuration error (no assumed allowance). Idempotent per period step. */
  async recalculate(actor: Principal, raw: unknown) {
    const input = parse(z.strictObject({ employeeId: uuid, leaveTypeId: uuid, period: z.string().regex(/^\d{4}$/), asOf: localDate }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'hr.leave.policy.manage');
      const employee = await tx.hrEmployee.findFirst({ where: { workspaceId: actor.workspaceId, id: input.employeeId } });
      const type = await tx.hrLeaveType.findFirst({ where: { workspaceId: actor.workspaceId, id: input.leaveTypeId } });
      if (!employee || !type) throw notFound('Employee or leave type');
      const policy = await this.policy(tx, employee, type.id, input.asOf);
      if (!policy) throw policyMissing('Leave accrual policy');
      const account = await this.account(tx, employee, type.id, type.unit, input.period);
      await lock(tx, actor.workspaceId, 'hr:leave-account:' + account.id);
      const rule = policy.accrualRule as { frequency: string; units: string; prorateFromStart: boolean };
      const start = fromDate(employee.startDate) > input.period + '-01-01' && rule.prorateFromStart ? fromDate(employee.startDate) : input.period + '-01-01';
      const steps: string[] = [];
      if (rule.frequency === 'MONTHLY') for (let m = 1; m <= 12; m++) { const key = `${input.period}-${String(m).padStart(2, '0')}`; if (key + '-01' <= input.asOf && key + '-31' >= start) steps.push(key); }
      if (rule.frequency === 'YEARLY' && input.period + '-01-01' <= input.asOf) steps.push(input.period);
      let created = 0;
      for (const step of steps) {
        const idem = `accrual:${policy.id}:v${policy.version}:${step}`;
        if (await tx.hrLeaveLedger.findUnique({ where: { accountId_idempotencyKey: { accountId: account.id, idempotencyKey: idem } } })) continue;
        await tx.hrLeaveLedger.create({ data: { workspaceId: actor.workspaceId, accountId: account.id, employeeId: employee.id, kind: 'ACCRUAL', units: rule.units, idempotencyKey: idem, policyVersion: policy.version, sourceId: policy.id } });
        created++;
      }
      const carry = policy.carryOverRule as { maxUnits: string };
      if (D(carry.maxUnits).gt(0)) {
        const previous = await tx.hrLeaveAccount.findUnique({ where: { workspaceId_employeeId_leaveTypeId_period: { workspaceId: actor.workspaceId, employeeId: employee.id, leaveTypeId: type.id, period: String(Number(input.period) - 1) } } });
        const idem = `carry:${policy.id}:v${policy.version}:${input.period}`;
        if (previous && !await tx.hrLeaveLedger.findUnique({ where: { accountId_idempotencyKey: { accountId: account.id, idempotencyKey: idem } } })) {
          const units = D((await HrLeaveService.balance(tx, previous.id)).available);
          const carried = Prisma.Decimal.max(0, Prisma.Decimal.min(units, D(carry.maxUnits)));
          if (carried.gt(0)) await tx.hrLeaveLedger.create({ data: { workspaceId: actor.workspaceId, accountId: account.id, employeeId: employee.id, kind: 'CARRY_OVER', units: carried.toFixed(4), idempotencyKey: idem, policyVersion: policy.version, sourceId: previous.id, note: 'Carry-over from ' + previous.period } });
        }
      }
      await evidence(tx, actor, 'HR_LEAVE_ACCOUNT', account.id, 'LEAVE_ACCRUED', { entries: created, policyVersion: policy.version });
      return { accountId: account.id, created, policyVersion: policy.version, ...(await HrLeaveService.balance(tx, account.id)) };
    });
  }

  /** Requested units from the effective schedule (rest days and policy/schedule holidays skipped); hourly or part-day explicitly. */
  private async units(tx: Tx, employee: HrEmployee, unit: string, from: string, to: string, holidays: string[], partDayMinutes?: number) {
    const expected = await HrScheduleService.expected(tx, employee, from, to);
    if (!expected.length && !(await tx.hrScheduleAssignment.count({ where: { workspaceId: employee.workspaceId, employeeId: employee.id } }))) throw policyMissing('Employee work schedule');
    const scheduleHolidays = await HrScheduleService.holidays(tx, employee, from, to);
    const days = dateRange(from, to).filter(d => expected.some(p => p.date === d && p.minutes > 0) && !holidays.includes(d) && !scheduleHolidays.has(d));
    if (unit === 'HOUR') {
      const minutes = partDayMinutes !== undefined ? partDayMinutes * days.length : expected.filter(p => days.includes(p.date)).reduce((s, p) => s + p.minutes, 0);
      return D(minutes).div(60).toDecimalPlaces(4);
    }
    if (partDayMinutes !== undefined) { const full = expected.find(p => days.includes(p.date))?.minutes ?? 480; return D(partDayMinutes).div(full).times(days.length).toDecimalPlaces(2); }
    return D(days.length);
  }

  async createRequest(actor: Principal, raw: unknown, key: string | null) {
    const input = parse(z.strictObject({ leaveTypeId: uuid, fromLocal: localDate, toLocal: localDate, partDayMinutes: z.number().int().min(15).max(720).optional(), reason: z.string().trim().max(1000).optional(), timezone: ianaZone.optional(), submit: z.boolean().default(true) }), raw);
    if (input.toLocal < input.fromLocal) throw new AppError('VALIDATION_FAILED', 'toLocal precedes fromLocal.', 400, { fields: [{ field: 'toLocal', reason: 'BEFORE_FROM' }] });
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'hr.leave.request_self');
      const employee = await myEmployee(tx, actor) as HrEmployee;
      if (key) { const prior = await tx.hrLeaveRequest.findUnique({ where: { workspaceId_employeeId_idempotencyKey: { workspaceId: actor.workspaceId, employeeId: employee.id, idempotencyKey: key } } }); if (prior) return this.view(prior, true); }
      const type = await tx.hrLeaveType.findFirst({ where: { workspaceId: actor.workspaceId, id: input.leaveTypeId } });
      if (!type) throw notFound('Leave type');
      const row = await tx.hrLeaveRequest.create({ data: { workspaceId: actor.workspaceId, employeeId: employee.id, leaveTypeId: type.id, fromLocal: asDate(input.fromLocal), toLocal: asDate(input.toLocal), partDayMinutes: input.partDayMinutes,
        timezone: input.timezone ?? employee.timezone, requestedUnits: '0', reasonSealed: input.reason ? encrypt(input.reason) : null, approvalChain: type.approvalChain as Prisma.InputJsonValue, createdByUserId: actor.userId, idempotencyKey: key } });
      await evidence(tx, actor, 'HR_LEAVE_REQUEST', row.id, 'LEAVE_REQUEST_CREATED', { leaveTypeId: type.id });
      return input.submit ? this.submitInTx(tx, actor, row.id, row.version) : this.view(row, true);
    });
  }
  /** Submit places an atomic REQUEST_HOLD; account lock serializes concurrent requests so balance cannot be overspent. */
  private async submitInTx(tx: Tx, actor: Principal, id: string, version: number) {
    const row = await tx.hrLeaveRequest.findUniqueOrThrow({ where: { id } });
    const employee = await tx.hrEmployee.findUniqueOrThrow({ where: { id: row.employeeId } });
    if (employee.userId !== actor.userId) throw new AppError('PERMISSION_DENIED', 'Employees submit their own leave.', 403);
    if (row.version !== version) throw new AppError('VERSION_CONFLICT', 'Request changed; reload.', 409);
    if (row.status !== 'DRAFT') throw new AppError('INVALID_STATE_TRANSITION', `Request is ${row.status}.`, 409);
    const type = await tx.hrLeaveType.findUniqueOrThrow({ where: { id: row.leaveTypeId } });
    const from = fromDate(row.fromLocal), to = fromDate(row.toLocal);
    const policy = await this.policy(tx, employee, type.id, from);
    if (type.paid && type.requiresBalance && !policy) throw policyMissing('Leave policy');
    if (policy && policy.leadTimeDays && from < new Date(Date.now() + policy.leadTimeDays * 86400000).toISOString().slice(0, 10)) throw new AppError('VALIDATION_FAILED', `Requests need ${policy.leadTimeDays} days lead time.`, 400, { fields: [{ field: 'fromLocal', reason: 'LEAD_TIME' }] });
    const overlap = await tx.hrLeaveRequest.findFirst({ where: { workspaceId: actor.workspaceId, employeeId: employee.id, id: { not: row.id }, status: { in: ['SUBMITTED', 'APPROVED'] }, fromLocal: { lte: row.toLocal }, toLocal: { gte: row.fromLocal } } });
    if (overlap) throw new AppError('LEAVE_OVERLAP', 'Request overlaps existing leave.', 409);
    const units = await this.units(tx, employee, type.unit, from, to, (policy?.holidays as string[] | undefined) ?? [], row.partDayMinutes ?? undefined);
    if (units.lte(0)) throw new AppError('VALIDATION_FAILED', 'Requested range contains no scheduled working time.', 400);
    let holdId: string | null = null;
    if (type.requiresBalance) {
      const account = await this.account(tx, employee, type.id, type.unit, from.slice(0, 4));
      await lock(tx, actor.workspaceId, 'hr:leave-account:' + account.id);
      const balance = await HrLeaveService.balance(tx, account.id);
      if (D(balance.available).lt(units) && !policy?.negativeAllowed) throw new AppError('INSUFFICIENT_LEAVE_BALANCE', 'Insufficient leave balance.', 409, { available: balance.available, requested: units.toFixed(4) });
      holdId = (await tx.hrLeaveLedger.create({ data: { workspaceId: actor.workspaceId, accountId: account.id, employeeId: employee.id, kind: 'REQUEST_HOLD', units: units.toFixed(4), sourceId: row.id, idempotencyKey: 'hold:' + row.id, policyVersion: policy?.version } })).id;
      await evidence(tx, actor, 'HR_LEAVE_ACCOUNT', account.id, 'LEAVE_BALANCE_HOLD_CREATED', { requestId: row.id, units: units.toFixed(4) }, false);
    }
    const updated = await tx.hrLeaveRequest.update({ where: { id: row.id }, data: { status: 'SUBMITTED', requestedUnits: units.toFixed(4), policyVersion: policy?.version, currentStep: 0, version: { increment: 1 } } });
    await evidence(tx, actor, 'HR_LEAVE_REQUEST', row.id, 'LEAVE_REQUESTED', { units: units.toFixed(4), holdId });
    return this.view(updated, true);
  }
  async submit(actor: Principal, id: string, raw: unknown) {
    const input = parse(z.strictObject({ expectedVersion }), raw);
    return inTx(this.db, actor, async (tx, actor) => { requirePermission(actor, 'hr.leave.request_self'); await lock(tx, actor.workspaceId, 'hr:leave:' + id); await this.ownRequest(tx, actor, id); return this.submitInTx(tx, actor, id, input.expectedVersion); });
  }
  private async ownRequest(tx: Tx, actor: Principal, id: string) {
    const row = await tx.hrLeaveRequest.findFirst({ where: { workspaceId: actor.workspaceId, id: parse(uuid, id) } });
    if (!row) throw notFound('Leave request'); return row;
  }
  view(row: HrLeaveRequest, includeReason: boolean) {
    return { id: row.id, employeeId: row.employeeId, leaveTypeId: row.leaveTypeId, fromLocal: fromDate(row.fromLocal), toLocal: fromDate(row.toLocal), partDayMinutes: row.partDayMinutes, timezone: row.timezone,
      requestedUnits: row.requestedUnits.toFixed(4), status: row.status, currentStep: row.currentStep, approvalChain: row.approvalChain, version: row.version, reason: includeReason ? decrypt(row.reasonSealed) : undefined };
  }
  /** Step authority: MANAGER = manager chain/team scope, DEPARTMENT = department scope, HR = workspace-wide approver. Delegation via approve_team scope. */
  private async canDecide(tx: Tx, actor: Principal, employee: HrEmployee, step: string) {
    if (step === 'HR') return actor.grants.get('hr.leave.approve_team') === 'WORKSPACE';
    if (step === 'DEPARTMENT') return Boolean(employee.departmentId && (await visibleDepartments(tx, actor, 'hr.leave.approve_team')).has(employee.departmentId));
    return teamAuthority(tx, actor, employee, 'hr.leave.approve_team');
  }
  async decide(actor: Principal, id: string, raw: unknown, decision: 'APPROVE' | 'REJECT') {
    const input = parse(z.strictObject({ expectedVersion, comment: z.string().trim().max(1000).optional(), breakglass: z.boolean().default(false) }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      await lock(tx, actor.workspaceId, 'hr:leave:' + id);
      const row = await this.ownRequest(tx, actor, id), employee = await tx.hrEmployee.findUniqueOrThrow({ where: { id: row.employeeId } });
      if (row.status === 'APPROVED' && decision === 'APPROVE' && row.version === input.expectedVersion + 1) return this.view(row, false); // duplicate approve: no second debit
      if (row.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT', 'Request changed; reload.', 409);
      if (row.status !== 'SUBMITTED') throw new AppError('INVALID_STATE_TRANSITION', `Request is ${row.status}.`, 409);
      const chain = row.approvalChain as string[], step = chain[row.currentStep] ?? 'MANAGER';
      const self = employee.userId === actor.userId;
      if (self && !(input.breakglass && actor.grants.has('hr.leave.balance.override'))) throw new AppError('PERMISSION_DENIED', 'Approvers cannot decide their own request.', 403);
      if (!self && !await this.canDecide(tx, actor, employee, step)) throw new AppError('PERMISSION_DENIED', 'Not an authorized approver for this step.', 403);
      await tx.hrLeaveApproval.create({ data: { workspaceId: actor.workspaceId, requestId: row.id, approverUserId: actor.userId, stepIndex: row.currentStep, decision, breakglass: self } });
      const hold = await tx.hrLeaveLedger.findFirst({ where: { workspaceId: actor.workspaceId, sourceId: row.id, kind: 'REQUEST_HOLD', active: true } });
      if (decision === 'REJECT') {
        if (hold) { await tx.hrLeaveLedger.update({ where: { id: hold.id }, data: { active: false } }); await tx.hrLeaveLedger.create({ data: { workspaceId: actor.workspaceId, accountId: hold.accountId, employeeId: employee.id, kind: 'RELEASE', units: hold.units, sourceId: row.id, idempotencyKey: 'release:' + row.id } }); }
        const updated = await tx.hrLeaveRequest.update({ where: { id: row.id }, data: { status: 'REJECTED', version: { increment: 1 } } });
        await evidence(tx, actor, 'HR_LEAVE_REQUEST', row.id, 'LEAVE_REJECTED', { step });
        return this.view(updated, false);
      }
      if (row.currentStep + 1 < chain.length) {
        const updated = await tx.hrLeaveRequest.update({ where: { id: row.id }, data: { currentStep: { increment: 1 }, version: { increment: 1 } } });
        await evidence(tx, actor, 'HR_LEAVE_REQUEST', row.id, 'LEAVE_STEP_APPROVED', { step }); return this.view(updated, false);
      }
      if (hold) { await tx.hrLeaveLedger.update({ where: { id: hold.id }, data: { active: false } }); await tx.hrLeaveLedger.create({ data: { workspaceId: actor.workspaceId, accountId: hold.accountId, employeeId: employee.id, kind: 'DEBIT', units: hold.units, sourceId: row.id, idempotencyKey: 'debit:' + row.id, policyVersion: hold.policyVersion } }); }
      const updated = await tx.hrLeaveRequest.update({ where: { id: row.id }, data: { status: 'APPROVED', version: { increment: 1 } } });
      // General calendars receive availability only; the private reason is never copied.
      await tx.hrAbsenceProjection.upsert({ where: { requestId: row.id }, create: { workspaceId: actor.workspaceId, employeeId: employee.id, requestId: row.id, startDate: row.fromLocal, endDate: row.toLocal }, update: { active: true } });
      await evidence(tx, actor, 'HR_LEAVE_REQUEST', row.id, 'LEAVE_APPROVED', { units: row.requestedUnits.toFixed(4) });
      await evidence(tx, actor, 'HR_EMPLOYEE', employee.id, 'ABSENCE_FREE_BUSY_PUBLISHED', { from: fromDate(row.fromLocal), to: fromDate(row.toLocal), visibility: 'FREE_BUSY' }, false);
      return this.view(updated, false);
    });
  }
  async cancel(actor: Principal, id: string, raw: unknown) {
    const input = parse(z.strictObject({ expectedVersion, reason: z.string().trim().max(500).optional() }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      await lock(tx, actor.workspaceId, 'hr:leave:' + id);
      const row = await this.ownRequest(tx, actor, id), employee = await tx.hrEmployee.findUniqueOrThrow({ where: { id: row.employeeId } });
      const self = employee.userId === actor.userId;
      if (!self && !actor.grants.has('hr.leave.balance.override')) throw notFound('Leave request');
      if (row.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT', 'Request changed; reload.', 409);
      if (row.status === 'APPROVED' && !actor.grants.has('hr.leave.balance.override') && fromDate(row.fromLocal) <= new Date().toISOString().slice(0, 10)) throw new AppError('INVALID_STATE_TRANSITION', 'Started approved leave requires an HR reversal.', 409);
      if (!['DRAFT', 'SUBMITTED', 'APPROVED'].includes(row.status)) throw new AppError('INVALID_STATE_TRANSITION', `Request is ${row.status}.`, 409);
      const hold = await tx.hrLeaveLedger.findFirst({ where: { sourceId: row.id, kind: 'REQUEST_HOLD', active: true } });
      if (hold) { await tx.hrLeaveLedger.update({ where: { id: hold.id }, data: { active: false } }); await tx.hrLeaveLedger.create({ data: { workspaceId: actor.workspaceId, accountId: hold.accountId, employeeId: employee.id, kind: 'RELEASE', units: hold.units, sourceId: row.id, idempotencyKey: 'release:' + row.id } }); }
      const debit = row.status === 'APPROVED' ? await tx.hrLeaveLedger.findFirst({ where: { sourceId: row.id, kind: 'DEBIT' } }) : null;
      if (debit) await tx.hrLeaveLedger.create({ data: { workspaceId: actor.workspaceId, accountId: debit.accountId, employeeId: employee.id, kind: 'ADJUSTMENT', units: debit.units, sourceId: row.id, idempotencyKey: 'reversal:' + row.id, note: 'Approved leave cancelled', createdByUserId: actor.userId } });
      await tx.hrAbsenceProjection.updateMany({ where: { requestId: row.id }, data: { active: false } });
      const updated = await tx.hrLeaveRequest.update({ where: { id: row.id }, data: { status: 'CANCELLED', version: { increment: 1 } } });
      await evidence(tx, actor, 'HR_LEAVE_REQUEST', row.id, 'LEAVE_CANCELLED', {});
      return this.view(updated, self);
    });
  }
  async mine(actor: Principal) {
    return inTx(this.db, actor, async (tx, actor) => {
      const employee = await myEmployee(tx, actor) as HrEmployee;
      return (await tx.hrLeaveRequest.findMany({ where: { workspaceId: actor.workspaceId, employeeId: employee.id }, orderBy: { fromLocal: 'desc' } })).map(r => this.view(r, true));
    });
  }
  /** Team/general availability view: absence spans only — never leave type reasons or medical details. */
  async calendar(actor: Principal, raw: unknown) {
    const q = parse(z.object({ from: localDate, to: localDate }).passthrough(), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      if (!actor.grants.has('hr.employee.read_department') && !actor.grants.has('hr.employee.read_all')) requirePermission(actor, 'hr.employee.read_self');
      const rows = await tx.hrAbsenceProjection.findMany({ where: { workspaceId: actor.workspaceId, active: true, startDate: { lte: asDate(q.to) }, endDate: { gte: asDate(q.from) } } });
      const employees = await tx.hrEmployee.findMany({ where: { id: { in: rows.map(r => r.employeeId) } }, select: { id: true, displayName: true } });
      return rows.map(r => ({ employeeId: r.employeeId, displayName: employees.find(e => e.id === r.employeeId)?.displayName, startDate: fromDate(r.startDate), endDate: fromDate(r.endDate), availability: 'BUSY_ABSENT' }));
    });
  }
  async reason(actor: Principal, id: string) {
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'hr.leave.reason.read');
      const row = await this.ownRequest(tx, actor, id);
      await tx.hrAccessAudit.create({ data: { workspaceId: actor.workspaceId, actorUserId: actor.userId, employeeId: row.employeeId, fields: ['leave.reason'] } });
      await evidence(tx, actor, 'HR_LEAVE_REQUEST', row.id, 'HR_SENSITIVE_RECORD_ACCESSED', { field: 'reason' });
      return { id: row.id, reason: decrypt(row.reasonSealed) };
    });
  }
}
