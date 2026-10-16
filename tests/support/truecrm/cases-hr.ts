import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { Generic, Probe } from './probe';
import { nextWeekday } from './fixtures';
import { seedDriveFile } from './files';

const H = '/api/v1/hr';
type World = Awaited<ReturnType<typeof import('./fixtures')['hrWorld']>>;
const h = (p: Probe) => p.x.h as World;
const svc = () => import('../../../src/server/hr/routes');
const addWeekdays = (date: string, n: number) => { const d = new Date(date + 'T00:00:00Z'); while (n > 0) { d.setUTCDate(d.getUTCDate() + 1); if (![0, 6].includes(d.getUTCDay())) n--; } return d.toISOString().slice(0, 10); };
const ledger = (p: Probe, kind?: string) => p.obs('hr_leave_ledger', { employeeId: p.ids.employeeId, ...(kind ? { kind } : {}) });

/** HR-managed employee for another user with an assigned office schedule. */
async function employeeFor(p: Probe, user: 'approver' | 'publisher' | 'marketer', departmentId = p.w.otherDepartment.id, timezone = 'Africa/Cairo') {
  const { hrPeople, hrSchedules } = await svc();
  const e = await hrPeople.create(h(p).hr, { employeeNumber: 'X-' + randomUUID().slice(0, 6), displayName: 'Extra ' + user, userId: p.w.users[user].id, departmentId, timezone, startDate: '2026-01-01', privateData: { phone: '+201000000009', salaryBand: 'B9' } });
  await hrPeople.activate(h(p).hr, e.id, { expectedVersion: e.version });
  await hrSchedules.assign(h(p).hr, e.id, { scheduleVersionId: h(p).version.id, effectiveFrom: '2026-01-01' });
  return e;
}
async function leaveType(p: Probe, policy: { holidays?: string[]; carryOver?: string; effectiveFrom?: string; accrual?: { frequency: 'NONE' | 'YEARLY' | 'MONTHLY'; units: string } } = {}) {
  const { hrLeave } = await svc();
  const type = await hrLeave.createType(h(p).hr, { name: 'Type ' + randomUUID().slice(0, 6), unit: 'DAY', paid: true, requiresBalance: true, approvalChain: ['MANAGER'] });
  await hrLeave.createPolicy(h(p).hr, { leaveTypeId: type.id, accrualRule: policy.accrual ?? { frequency: 'NONE', units: '0' }, carryOverRule: { maxUnits: policy.carryOver ?? '0' }, holidays: policy.holidays ?? [], effectiveFrom: policy.effectiveFrom ?? '2026-01-01' });
  return type;
}
const allocate = async (p: Probe, leaveTypeId: string, units: string, period = nextWeekday(2).slice(0, 4)) =>
  p.req('hr', 'POST', `${H}/leave/balances/adjust`, { employeeId: p.ids.employeeId, leaveTypeId, period, units, kind: 'ALLOCATION', note: 'Allocation ' + randomUUID().slice(0, 4) }, { 'Idempotency-Key': p.key('alloc') });
const request = (p: Probe, leaveTypeId: string, from: string, to = from, extra: Record<string, unknown> = {}) =>
  p.req('employee', 'POST', `${H}/leave/requests`, { leaveTypeId, fromLocal: from, toLocal: to, ...extra }, { 'Idempotency-Key': p.key('leave') });
async function correctionSession(p: Probe, date: string, events: [string, string][], requester: 'hr' | 'employee' = 'hr') {
  const body = { employeeId: p.ids.employeeId, targetDate: date, reason: 'Recorded on paper', proposedEvents: events.map(([type, time]) => ({ type, occurredAt: `${date}T${time}:00+02:00` })) };
  const requested = await p.req(requester, 'POST', `${H}/attendance/corrections`, body);
  p.ok('correction requested', requested);
  const approved = await p.req('manager', 'POST', `${H}/attendance/corrections/${requested.body.data?.id}/approve`, { expectedVersion: requested.body.data?.version });
  p.ok('correction approved and applied', approved);
  return approved.body.data as { workSessionId: string };
}

export const hrGeneric: Generic = {
  scenario: 'hr_attendance',
  async foreign(p) { return { actor: 'hr', path: `${H}/employees/${p.ids.foreignEmployeeId}` }; },
  async mutation(p) {
    return { actor: 'hr', deniedActor: 'employee', req: { method: 'POST', path: `${H}/employees`, body: { employeeNumber: 'G-' + randomUUID().slice(0, 6), displayName: 'Generic Hire', timezone: 'Africa/Cairo', startDate: '2026-02-01' } },
      count: () => p.q(db => db.hrEmployee.count({ where: { workspaceId: p.f.workspaceId } })), resourceId: res => res.body.data?.id };
  },
  async idempotent(p) {
    return { actor: 'employee', req: { method: 'POST', path: `${H}/me/clock-in`, body: { source: 'WEB' } },
      count: () => p.q(db => db.hrWorkSession.count({ where: { employeeId: p.ids.employeeId } })), id: res => res.body.data?.id };
  },
};

export const hrCases: Record<string, (p: Probe) => Promise<void>> = {
  // ------------------------------------------------------------ 01 profiles
  async '01-employee-profiles::AC01'(p) {
    const file = await seedDriveFile(p.db, p.f.workspaceId, p.w.users.hr.id, Buffer.from('contract'), 'contract.pdf');
    p.ok('confidential document bound', await p.req('hr', 'POST', `${H}/employees/${p.ids.employeeId}/documents/bind`, { fileId: file.id, category: 'CONTRACT', confidentiality: 'CONFIDENTIAL' }));
    const own = await p.req('employee', 'GET', `${H}/employees/${p.ids.employeeId}`);
    p.ok('employee reads own profile', own);
    p.check('own contact data visible', own.body.data?.privateData?.phone === '+201000000001', own.body.data?.privateData);
    p.check('salary band and HR notes hidden', own.body.data?.privateData?.salaryBand === undefined && own.body.data?.privateData?.notes === undefined);
    const docs = await p.req('employee', 'GET', `${H}/employees/${p.ids.employeeId}/documents`);
    p.check('confidential documents hidden from self-service', Array.isArray(docs.body.data) && docs.body.data.length === 0, docs.body.data);
    p.check('sensitive self read audited', (await p.q(db => db.hrAccessAudit.count({ where: { employeeId: p.ids.employeeId, actorUserId: p.w.users.employee.id } }))) > 0);
  },
  async '01-employee-profiles::AC02'(p) {
    const other = await employeeFor(p, 'approver');
    const res = await p.req('manager', 'GET', `${H}/employees/${other.id}`);
    p.status('other-department employee concealed from manager', res, [403, 404]);
    const team = await p.req('manager', 'GET', `${H}/employees/${p.ids.employeeId}`);
    p.ok('manager reads own team member directory data', team);
    p.check('confidential fields excluded for manager', team.body.data?.privateData === undefined, Object.keys(team.body.data ?? {}));
  },
  async '01-employee-profiles::AC03'(p) {
    const audit = await p.obs('audit_events', { resourceId: p.ids.terminatedEmployeeId });
    p.check('creation and termination audit retained', ['EMPLOYEE_CREATED', 'EMPLOYEE_TERMINATED'].every(a => audit.some(r => r.action === a)), audit.map(r => r.action));
    const res = await p.req('hr', 'GET', `${H}/employees/${p.ids.terminatedEmployeeId}`);
    p.ok('terminated profile retained for HR', res);
    p.check('status TERMINATED with end date', res.body.data?.status === 'TERMINATED' && Boolean(res.body.data?.endDate));
  },
  // ------------------------------------------------------------ 02 schedules
  async '02-work-schedules-and-shifts::AC01'(p) {
    const schedule = await p.req('hr', 'POST', `${H}/schedules`, { name: 'Night ' + randomUUID().slice(0, 4), type: 'FIXED', timezone: 'Africa/Cairo' });
    const version = await p.req('hr', 'POST', `${H}/schedules/${schedule.body.data?.id}/versions`, { effectiveFrom: '2026-01-01', rules: { windows: { '1': [{ start: '22:00', end: '06:00' }] }, unpaidBreakMinutes: 30 } });
    p.ok('overnight version published', version);
    const other = await p.q(async db => db.hrEmployee.create({ data: { workspaceId: p.f.workspaceId, employeeNumber: 'N-' + randomUUID().slice(0, 6), displayName: 'Night', timezone: 'Africa/Cairo', startDate: new Date('2026-01-01'), status: 'ACTIVE', createdByUserId: p.w.users.hr.id } }));
    p.ok('assigned', await p.req('hr', 'POST', `${H}/employees/${other.id}/schedule-assignments`, { scheduleVersionId: version.body.data?.id, effectiveFrom: '2026-01-01' }));
    const res = await p.req('hr', 'GET', `${H}/employees/${other.id}/expected-workdays?from=2026-03-02&to=2026-03-02`);
    const [period] = res.body.data ?? [];
    p.check('overnight shift belongs to the start date with 7.5h net', period?.date === '2026-03-02' && period?.minutes === 450, period);
    p.check('period ends on the next day', String(period?.endAt).startsWith('2026-03-03'), period?.endAt);
  },
  async '02-work-schedules-and-shifts::AC02'(p) {
    const schedule = await p.req('hr', 'POST', `${H}/schedules`, { name: 'DST ' + randomUUID().slice(0, 4), type: 'FIXED', timezone: 'America/New_York' });
    const version = await p.req('hr', 'POST', `${H}/schedules/${schedule.body.data?.id}/versions`, { effectiveFrom: '2026-10-01', rules: { windows: { '0': [{ start: '00:30', end: '03:00' }] } } });
    const other = await p.q(db => db.hrEmployee.create({ data: { workspaceId: p.f.workspaceId, employeeNumber: 'D-' + randomUUID().slice(0, 6), displayName: 'DST', timezone: 'America/New_York', startDate: new Date('2026-01-01'), status: 'ACTIVE', createdByUserId: p.w.users.hr.id } }));
    await p.req('hr', 'POST', `${H}/employees/${other.id}/schedule-assignments`, { scheduleVersionId: version.body.data?.id, effectiveFrom: '2026-10-01' });
    const res = await p.req('hr', 'GET', `${H}/employees/${other.id}/expected-workdays?from=2026-11-01&to=2026-11-01`);
    const [period] = res.body.data ?? [];
    p.check('fall-back day counts the repeated hour (3.5h elapsed)', period?.minutes === 210, period);
    p.check('instants stored in UTC from the IANA zone', period?.startAt === '2026-11-01T04:30:00.000Z', period?.startAt);
  },
  async '02-work-schedules-and-shifts::AC03'(p) {
    const res = await p.req('hr', 'POST', `${H}/employees/${p.ids.employeeId}/schedule-assignments`, { scheduleVersionId: h(p).version.id, effectiveFrom: '2026-03-01' });
    p.status('overlapping assignment rejected', res, [409]); p.code('overlap code', res, ['SCHEDULE_ASSIGNMENT_OVERLAP']);
    p.check('single assignment persisted', (await p.q(db => db.hrScheduleAssignment.count({ where: { employeeId: p.ids.employeeId } }))) === 1);
  },
  async '02-work-schedules-and-shifts::AC04'(p) {
    const before = await p.obs('hr_timesheets', { id: p.ids.lockedTimesheetId });
    const retro = await p.req('hr', 'POST', `${H}/schedules/${h(p).schedule.id}/versions`, { effectiveFrom: '2026-02-01', rules: { windows: { '1': [{ start: '08:00', end: '18:00' }] } } });
    p.status('retroactive edit over finalized timesheets rejected', retro, [409]);
    const future = await p.req('hr', 'POST', `${H}/schedules/${h(p).schedule.id}/versions`, { effectiveFrom: nextWeekday(20), rules: { windows: { '1': [{ start: '08:00', end: '18:00' }] } } });
    p.ok('future-dated version allowed', future);
    const after = await p.obs('hr_timesheets', { id: p.ids.lockedTimesheetId });
    p.check('approved/locked timesheet totals unchanged', JSON.stringify(after[0]?.totals) === JSON.stringify(before[0]?.totals) && after[0]?.status === 'LOCKED');
  },
  // ------------------------------------------------------------ 03 clock & breaks
  async '03-clock-and-breaks::AC01'(p) {
    const key = p.key('clock');
    const a = await p.req('employee', 'POST', `${H}/me/clock-in`, { source: 'WEB' }, { 'Idempotency-Key': key });
    const b = await p.req('employee', 'POST', `${H}/me/clock-in`, { source: 'WEB' }, { 'Idempotency-Key': key });
    p.ok('clock-in recorded', a); p.check('duplicate returns the same session', a.body.data?.id === b.body.data?.id && Boolean(a.body.data?.id));
    const again = await p.req('employee', 'POST', `${H}/me/clock-in`, { source: 'WEB' });
    p.status('second session without the key rejected', again, [409]);
    p.check('one event for the key', (await p.obs('hr_work_events', { idempotencyKey: key })).length === 1);
    p.check('one open session', (await p.q(db => db.hrWorkSession.count({ where: { employeeId: p.ids.employeeId, status: 'OPEN' } }))) === 1);
  },
  async '03-clock-and-breaks::AC02'(p) {
    const open = await p.req('employee', 'POST', `${H}/me/clock-in`, { source: 'WEB' });
    await p.q(db => db.hrWorkSession.update({ where: { id: open.body.data?.id }, data: { startedAt: new Date(Date.now() - 17 * 3600000) } }));
    const { HrJobsService } = await import('../../../src/server/hr/jobs-service');
    await p.call(() => new HrJobsService(p.db).tickAnomalies());
    const row = await p.q(db => db.hrWorkSession.findUniqueOrThrow({ where: { id: open.body.data?.id } }));
    p.check('missing clock-out flagged INCOMPLETE (no fabricated hours)', row.status === 'INCOMPLETE' && row.endedAt === null, row.status);
    p.check('anomaly event emitted', (await p.obs('outbox_events', { resourceId: row.id, eventType: 'ATTENDANCE_ANOMALY_DETECTED' })).length === 1);
  },
  async '03-clock-and-breaks::AC03'(p) {
    const res = await p.req('employee', 'POST', `${H}/me/clock-in`, { source: 'MOBILE', evidence: { gps: { latitude: 30.04, longitude: 31.23 } } });
    p.ok('clock-in without a location policy', res);
    const events = await p.obs('hr_work_events', { sessionId: res.body.data?.id });
    p.check('no GPS evidence stored when policy does not require it', (await p.q(db => db.hrAttendanceEvidence.count({ where: { eventId: { in: events.map(e => e.id) } } }))) === 0);
  },
  async '03-clock-and-breaks::AC04'(p) {
    await p.req('employee', 'POST', `${H}/me/clock-in`, { source: 'WEB' });
    p.ok('break started', await p.req('employee', 'POST', `${H}/me/break/start`, {}));
    const overlap = await p.req('employee', 'POST', `${H}/me/break/start`, {});
    p.status('overlapping break rejected', overlap, [409]);
    p.check('single open break', (await p.q(db => db.hrBreak.count({ where: { workspaceId: p.f.workspaceId, endedAt: null } }))) === 1);
  },
  // ------------------------------------------------------------ 04 attendance & corrections
  async '04-attendance-and-corrections::AC01'(p) {
    const original = await p.obs('hr_work_events', { sessionId: p.ids.workSessionId });
    const requested = await p.req('employee', 'POST', `${H}/attendance/corrections`, { employeeId: p.ids.employeeId, workSessionId: p.ids.workSessionId, reason: 'Forgot clock out', proposedEvents: [{ type: 'CLOCK_OUT', occurredAt: p.ids.correctedClockOutAt }] });
    const approved = await p.req('manager', 'POST', `${H}/attendance/corrections/${requested.body.data?.id}/approve`, { expectedVersion: requested.body.data?.version });
    p.ok('supervisor approved', approved);
    const after = await p.obs('hr_work_events', { sessionId: p.ids.workSessionId });
    p.check('original raw events still queryable', original.every(o => after.some(a => a.id === o.id && a.occurredAt.getTime() === o.occurredAt.getTime())));
    p.check('superseding correction event appended', after.some(e => e.supersedesEventId && e.correctionId === requested.body.data?.id));
    p.check('correction history keeps before/after', (await p.q(db => db.hrCorrectionHistory.count({ where: { correctionId: requested.body.data?.id } }))) === 1);
  },
  async '04-attendance-and-corrections::AC02'(p) {
    const requested = await p.req('employee', 'POST', `${H}/attendance/corrections`, { employeeId: p.ids.employeeId, workSessionId: p.ids.workSessionId, reason: 'Late clock-in', proposedEvents: [{ type: 'CLOCK_OUT', occurredAt: p.ids.correctedClockOutAt }] });
    const body = { expectedVersion: requested.body.data?.version };
    const [a, b] = await Promise.all([p.req('manager', 'POST', `${H}/attendance/corrections/${requested.body.data?.id}/approve`, body), p.req('hr', 'POST', `${H}/attendance/corrections/${requested.body.data?.id}/approve`, body)]);
    p.check('exactly one approval applied', [a, b].filter(r => r.status === 200).length === 1, [a.status, b.status]);
    p.check('single application history', (await p.q(db => db.hrCorrectionHistory.count({ where: { correctionId: requested.body.data?.id } }))) === 1);
  },
  async '04-attendance-and-corrections::AC03'(p) {
    const res = await p.req('employee', 'POST', `${H}/attendance/corrections`, { employeeId: p.ids.employeeId, targetDate: '2026-02-03', reason: 'Old day', proposedEvents: [{ type: 'CLOCK_IN', occurredAt: '2026-02-03T09:00:00+02:00' }] });
    p.status('locked period rejects corrections', res, [409]); p.code('locked code', res, ['TIMESHEET_LOCKED']);
    p.check('no correction persisted', (await p.q(db => db.hrAttendanceCorrection.count({ where: { employeeId: p.ids.employeeId, targetDate: new Date('2026-02-03') } }))) === 0);
  },
  // ------------------------------------------------------------ 05 timesheets
  async '05-timesheets::AC01'(p) {
    const sheet = await p.req('employee', 'POST', `${H}/timesheets/compile`, { periodStart: '2026-03-02', periodEnd: '2026-03-06' });
    const body = { expectedVersion: sheet.body.data?.version };
    const a = await p.req('employee', 'POST', `${H}/timesheets/${sheet.body.data?.id}/submit`, body), b = await p.req('employee', 'POST', `${H}/timesheets/${sheet.body.data?.id}/submit`, body);
    p.ok('first submit', a); p.ok('repeat submit of the same version', b);
    p.check('one submission review', (await p.q(db => db.hrTimesheetReview.count({ where: { timesheetId: sheet.body.data?.id, decision: 'SUBMITTED' } }))) === 1);
  },
  async '05-timesheets::AC02'(p) {
    const edit = await p.req('employee', 'PATCH', `${H}/timesheets/${p.ids.lockedTimesheetId}`, { workedMinutes: 9999 });
    p.status('locked timesheet edit rejected', edit, [409]);
    const correction = () => p.req('employee', 'POST', `${H}/attendance/corrections`, { employeeId: p.ids.employeeId, targetDate: '2026-02-04', reason: 'Missed', proposedEvents: [{ type: 'CLOCK_IN', occurredAt: '2026-02-04T09:00:00+02:00' }, { type: 'CLOCK_OUT', occurredAt: '2026-02-04T17:00:00+02:00' }] });
    p.status('correction blocked before reopen', await correction(), [409]);
    const [sheet] = await p.obs('hr_timesheets', { id: p.ids.lockedTimesheetId });
    p.ok('authorized reopen', await p.req('hr', 'POST', `${H}/timesheets/${sheet.id}/reopen`, { expectedVersion: sheet.version, reason: 'Missed day' }));
    p.ok('correction accepted after reopen', await correction());
  },
  async '05-timesheets::AC03'(p) {
    const date = '2026-03-09';
    await correctionSession(p, date, [['CLOCK_IN', '09:00'], ['CLOCK_OUT', '17:00']]);
    const task = await p.q(db => db.task.create({ data: { id: randomUUID(), workspaceId: p.f.workspaceId, title: 'Project work', status: 'IN_PROGRESS', priority: 'NORMAL', createdByUserId: p.w.users.employee.id, responsibleUserId: p.w.users.employee.id, requiresResult: false, completionControl: false, subtaskCompletionPolicy: 'IGNORE', isTimeTrackingEnabled: true, createdAt: new Date(), updatedAt: new Date() } }));
    await p.q(db => db.taskTimeEntry.create({ data: { id: randomUUID(), workspaceId: p.f.workspaceId, taskId: task.id, userId: p.w.users.employee.id, startedAt: new Date(date + 'T07:00:00Z'), endedAt: new Date(date + 'T15:00:00Z'), durationSeconds: 28800, source: 'MANUAL', status: 'COMPLETED', createdAt: new Date(), updatedAt: new Date() } }));
    const sheet = await p.req('employee', 'POST', `${H}/timesheets/compile`, { periodStart: date, periodEnd: date });
    p.ok('timesheet compiled', sheet);
    p.check('worked minutes come from attendance only (8h, not 16h)', sheet.body.data?.totals?.workedMinutes === 480, sheet.body.data?.totals);
  },
  // ------------------------------------------------------------ 06 overtime
  async '06-overtime-policy::AC01'(p) {
    p.ok('policy configured', await p.req('hr', 'POST', `${H}/overtime/policies`, { thresholds: { dailyMinutes: 480, weeklyMinutes: 2400 }, eligibleEmploymentTypes: ['FULL_TIME'], effectiveFrom: '2026-01-01' }));
    const days = ['2026-03-16', '2026-03-17', '2026-03-18', '2026-03-19', '2026-03-20'];
    const events = days.flatMap((d, i) => [{ employeeId: p.ids.employeeId, type: 'CLOCK_IN', occurredAt: `${d}T08:00:00+02:00`, externalId: 'in-' + i + randomUUID() }, { employeeId: p.ids.employeeId, type: 'CLOCK_OUT', occurredAt: `${d}T18:00:00+02:00`, externalId: 'out-' + i + randomUUID() }]);
    p.ok('terminal events imported', await p.req('hr', 'POST', `${H}/clock-events/import`, { events }));
    const res = await p.req('hr', 'POST', `${H}/overtime/recalculate`, { employeeId: p.ids.employeeId, from: days[0], to: days[4] });
    p.ok('overtime calculated', res);
    const entries = res.body.data?.entries ?? [];
    p.check('daily excess counted once (5 × 120)', entries.filter((e: { rule: string }) => e.rule === 'DAILY').reduce((s: number, e: { minutes: number }) => s + e.minutes, 0) === 600, entries);
    p.check('weekly rule does not duplicate daily minutes', !entries.some((e: { rule: string }) => e.rule === 'WEEKLY'));
  },
  async '06-overtime-policy::AC02'(p) {
    const date = '2026-03-10';
    await correctionSession(p, date, [['CLOCK_IN', '09:00'], ['BREAK_START', '12:00'], ['BREAK_END', '13:00'], ['CLOCK_OUT', '18:00']]);
    const res = await p.req('hr', 'GET', `${H}/employees/${p.ids.employeeId}/attendance?from=${date}&to=${date}`);
    const [day] = res.body.data ?? [];
    p.check('one-hour unpaid break excluded from worked time', day?.workedMinutes === 480 && day?.breakMinutes === 60, day);
  },
  async '06-overtime-policy::AC03'(p) {
    await p.req('hr', 'POST', `${H}/overtime/policies`, { thresholds: { dailyMinutes: 60 }, eligibleEmploymentTypes: ['FULL_TIME'], effectiveFrom: '2026-01-01' });
    const res = await p.req('hr', 'POST', `${H}/overtime/recalculate`, { employeeId: p.ids.employeeId, from: '2026-03-01', to: '2026-03-31' });
    p.ok('recalculated', res);
    p.check('payroll explicitly not calculated', res.body.data?.payroll === 'NOT_CALCULATED');
    const rows = await p.q(db => db.hrOvertimeEntry.findMany({ where: { employeeId: p.ids.employeeId } }));
    p.check('overtime entries carry minutes only (no money)', rows.every(r => !Object.keys(r).some(k => /amount|pay|rate|currency/i.test(k))));
  },
  // ------------------------------------------------------------ 07 leave balances
  async '07-leave-types-balances::AC01'(p) {
    const dayA = p.ids.leaveDateA, dayB = addWeekdays(dayA, 1);
    const [a, b] = await Promise.all([request(p, p.ids.leaveTypeId, dayA), request(p, p.ids.leaveTypeId, dayB)]);
    p.check('only one request holds the last day', [a, b].filter(r => r.status < 300).length === 1, [a.status, b.status]);
    p.check('loser rejected for insufficient balance', [a, b].some(r => r.body.error?.code === 'INSUFFICIENT_LEAVE_BALANCE'));
    const holds = (await ledger(p, 'REQUEST_HOLD')).filter(r => r.active);
    p.check('active holds never exceed balance', holds.reduce((s, r) => s + Number(r.units), 0) <= 1);
  },
  async '07-leave-types-balances::AC02'(p) {
    const dayA = addWeekdays(nextWeekday(3), 2), dayB = addWeekdays(dayA, 1), type = await leaveType(p, { holidays: [dayB] });
    await allocate(p, type.id, '5', dayA.slice(0, 4));
    const res = await request(p, type.id, dayA, dayB);
    p.ok('request submitted', res);
    p.check('holiday skipped from deduction', res.body.data?.requestedUnits === '1.0000', res.body.data?.requestedUnits);
  },
  async '07-leave-types-balances::AC03'(p) {
    const type = await leaveType(p, { carryOver: '2', effectiveFrom: '2025-01-01' });
    p.ok('previous period allocation', await allocate(p, type.id, '3', '2025'));
    const res = await p.req('hr', 'POST', `${H}/leave/balances/recalculate`, { employeeId: p.ids.employeeId, leaveTypeId: type.id, period: '2026', asOf: '2026-01-05' });
    p.ok('recalculated', res);
    const carry = await p.q(db => db.hrLeaveLedger.findFirst({ where: { employeeId: p.ids.employeeId, kind: 'CARRY_OVER' } }));
    p.check('carry-over capped by policy', carry?.units.toFixed(4) === '2.0000', carry?.units.toFixed(4));
    p.check('carry-over keeps policy version and source trace', Boolean(carry?.policyVersion && carry.sourceId && carry.idempotencyKey?.startsWith('carry:')), carry);
  },
  // ------------------------------------------------------------ 08 leave requests
  async '08-leave-requests-and-approvals::AC01'(p) {
    const res = await request(p, p.ids.leaveTypeId, p.ids.leaveDateA, addWeekdays(p.ids.leaveDateA, 1));
    p.status('insufficient balance blocks submit', res, [409]); p.code('balance code', res, ['INSUFFICIENT_LEAVE_BALANCE']);
    p.check('no hold created', (await ledger(p, 'REQUEST_HOLD')).length === 0);
  },
  async '08-leave-requests-and-approvals::AC02'(p) {
    const res = await request(p, p.ids.leaveTypeId, p.ids.leaveDateA);
    const rejected = await p.req('manager', 'POST', `${H}/leave/requests/${res.body.data?.id}/reject`, { expectedVersion: res.body.data?.version });
    p.ok('manager rejected', rejected);
    const balances = await p.req('employee', 'GET', `${H}/me/leave-balances`);
    const balance = (balances.body.data ?? []).find((b: { leaveTypeId: string }) => b.leaveTypeId === p.ids.leaveTypeId);
    p.check('reserved units restored', balance?.available === '1.0000' && balance?.held === '0.0000', balance);
    p.check('release recorded in the ledger', (await ledger(p, 'RELEASE')).length === 1);
  },
  async '08-leave-requests-and-approvals::AC03'(p) {
    const res = await request(p, p.ids.leaveTypeId, p.ids.leaveDateA, p.ids.leaveDateA, { reason: 'Medical: confidential diagnosis' });
    await p.req('manager', 'POST', `${H}/leave/requests/${res.body.data?.id}/approve`, { expectedVersion: res.body.data?.version });
    const cal = await p.req('manager', 'GET', `${H}/absences/calendar?from=${p.ids.leaveDateA}&to=${p.ids.leaveDateA}`);
    p.ok('calendar readable', cal);
    p.check('absence shown', (cal.body.data ?? []).some((r: { employeeId: string }) => r.employeeId === p.ids.employeeId));
    p.check('reason never in the calendar', !JSON.stringify(cal.body).includes('diagnosis'));
  },
  async '08-leave-requests-and-approvals::AC04'(p) {
    const res = await request(p, p.ids.leaveTypeId, p.ids.leaveDateA), body = { expectedVersion: res.body.data?.version };
    const a = await p.req('manager', 'POST', `${H}/leave/requests/${res.body.data?.id}/approve`, body), b = await p.req('manager', 'POST', `${H}/leave/requests/${res.body.data?.id}/approve`, body);
    p.ok('approved', a); p.ok('duplicate approval acknowledged', b);
    p.check('exactly one debit', (await ledger(p, 'DEBIT')).length === 1);
  },
  // ------------------------------------------------------------ 09 work reports
  async '09-work-reports::AC01'(p) {
    const today = new Date().toISOString().slice(0, 10), attendance = () => p.req('employee', 'GET', `${H}/employees/${p.ids.employeeId}/attendance?from=${today}&to=${today}`);
    const before = (await attendance()).body.data?.[0]?.workedMinutes;
    const report = await p.req('employee', 'POST', `${H}/work-reports`, { periodType: 'DAY', periodStart: today, periodEnd: today, summary: 'Worked 10 hours on reports' });
    await p.req('employee', 'POST', `${H}/work-reports/${report.body.data?.id}/submit`, { expectedVersion: report.body.data?.version });
    const after = (await attendance()).body.data?.[0]?.workedMinutes;
    p.check('attendance hours unaffected by work reports', before === after, { before, after });
    p.check('report persisted separately', (await p.q(db => db.hrWorkReport.count({ where: { employeeId: p.ids.employeeId } }))) === 1);
  },
  async '09-work-reports::AC02'(p) {
    await employeeFor(p, 'approver');
    const { hrInsights } = await svc(), approver = await p.w.principal('approver');
    const other = await hrInsights.createReport(approver, { periodType: 'WEEK', periodStart: '2026-03-02', periodEnd: '2026-03-06', summary: 'Finance team' });
    const list = await p.req('employee', 'GET', `${H}/work-reports`);
    p.check('unrelated team report not listed', !(list.body.data ?? []).some((r: { id: string }) => r.id === other.id));
    const edit = await p.req('employee', 'PATCH', `${H}/work-reports/${other.id}`, { expectedVersion: other.version, summary: 'x' });
    p.status('unrelated report concealed', edit, [403, 404]);
  },
  async '09-work-reports::AC03'(p) {
    const report = await p.req('employee', 'POST', `${H}/work-reports`, { periodType: 'WEEK', periodStart: '2026-03-02', periodEnd: '2026-03-06', summary: 'Original summary' });
    const submitted = await p.req('employee', 'POST', `${H}/work-reports/${report.body.data?.id}/submit`, { expectedVersion: report.body.data?.version });
    p.ok('reviewed', await p.req('manager', 'POST', `${H}/work-reports/${report.body.data?.id}/review`, { expectedVersion: submitted.body.data?.version, comment: 'Good' }));
    const edit = await p.req('employee', 'PATCH', `${H}/work-reports/${report.body.data?.id}`, { expectedVersion: submitted.body.data?.version + 1, summary: 'Rewritten' });
    p.status('reviewed report immutable', edit, [409]);
    const review = await p.q(db => db.hrWorkReportReview.findFirst({ where: { reportId: report.body.data?.id } }));
    p.check('reviewed version snapshot preserved', (review?.snapshot as { summary?: string })?.summary === 'Original summary');
  },
  // ------------------------------------------------------------ 10 lifecycle & docs
  async '10-onboarding-offboarding-and-docs::AC01'(p) {
    const role = await p.q(db => db.role.create({ data: { workspaceId: p.f.otherWorkspaceId, name: 'Member ' + randomUUID().slice(0, 4) } }));
    await p.q(db => db.workspaceMembership.create({ data: { workspaceId: p.f.otherWorkspaceId, userId: p.w.users.employee.id, roleId: role.id } }));
    p.ok('offboarding approved', await p.req('hr', 'POST', `${H}/employees/${p.ids.employeeId}/offboard`, { effectiveAt: new Date(Date.now() - 1000).toISOString(), reason: 'Leaving' }));
    const { HrJobsService } = await import('../../../src/server/hr/jobs-service');
    await p.call(() => new HrJobsService(p.db).tickAccessTransitions());
    const memberships = await p.q(db => db.workspaceMembership.findMany({ where: { userId: p.w.users.employee.id } }));
    p.check('this workspace membership suspended', memberships.find(m => m.workspaceId === p.f.workspaceId)?.status === 'SUSPENDED');
    p.check('other workspace membership untouched', memberships.find(m => m.workspaceId === p.f.otherWorkspaceId)?.status === 'ACTIVE');
    p.check('global user account untouched', (await p.q(db => db.user.findUniqueOrThrow({ where: { id: p.w.users.employee.id } }))).status === 'ACTIVE');
  },
  async '10-onboarding-offboarding-and-docs::AC02'(p) {
    const file = await seedDriveFile(p.db, p.f.workspaceId, p.w.users.hr.id, Buffer.from('policy'), 'policy.pdf');
    p.ok('standard document bound', await p.req('hr', 'POST', `${H}/employees/${p.ids.employeeId}/documents/bind`, { fileId: file.id, category: 'POLICY_ACK', confidentiality: 'STANDARD' }));
    const before = await p.req('employee', 'GET', `${H}/employees/${p.ids.employeeId}/documents`);
    p.check('visible with HR and File rights', (before.body.data ?? []).length === 1);
    await p.q(db => db.filePermissionAssignment.create({ data: { id: randomUUID(), workspaceId: p.f.workspaceId, resourceType: 'FILE', resourceId: file.id, subjectType: 'USER', subjectId: p.w.users.employee.id, permissionLevel: 'NONE', inheritanceMode: 'EXPLICIT' } }));
    const after = await p.req('employee', 'GET', `${H}/employees/${p.ids.employeeId}/documents`);
    p.check('File ACL denial hides the attachment', (after.body.data ?? []).length === 0);
  },
  async '10-onboarding-offboarding-and-docs::AC03'(p) {
    const res = await p.req('hr', 'POST', `${H}/employees/${p.ids.employeeId}/offboard`, { effectiveAt: new Date(Date.now() - 1000).toISOString(), reason: 'Leaving' });
    const { HrJobsService } = await import('../../../src/server/hr/jobs-service');
    // Deterministic infrastructure fault: membership revocation fails inside the transaction.
    const bound = <T extends object>(t: T, k: string | symbol) => { const v = Reflect.get(t, k, t); return typeof v === 'function' ? v.bind(t) : v; };
    const failing = new Proxy(p.db, { get(target, prop) {
      if (prop !== '$transaction') return bound(target, prop);
      return (fn: (tx: unknown) => Promise<unknown>) => target.$transaction(tx => fn(new Proxy(tx, { get(t, k) {
        return k === 'workspaceMembership' ? { findUnique: (a: never) => t.workspaceMembership.findUnique(a), update: async () => { throw new Error('IdP unavailable'); } } : bound(t, k);
      } })));
    } }) as PrismaClient;
    await p.call(() => new HrJobsService(failing).tickAccessTransitions());
    const transition = await p.q(db => db.hrAccessTransition.findFirstOrThrow({ where: { caseId: res.body.data?.id } }));
    p.check('failure scheduled for retry', transition.status === 'RETRY' && transition.errorCode === 'MEMBERSHIP_REVOCATION_FAILED', transition.status);
    const lifecycle = await p.req('hr', 'GET', `${H}/lifecycle/${res.body.data?.id}`);
    p.check('lifecycle not falsely completed', lifecycle.body.data?.status !== 'ACCESS_REVOKED', lifecycle.body.data?.status);
    p.check('membership still active until retry succeeds', (await p.q(db => db.workspaceMembership.findFirstOrThrow({ where: { workspaceId: p.f.workspaceId, userId: p.w.users.employee.id } }))).status === 'ACTIVE');
  },
  // ------------------------------------------------------------ 11 security, retention, analytics
  async '11-hr-security-retention-and-analytics::AC01'(p) {
    const res = await request(p, p.ids.leaveTypeId, p.ids.leaveDateA, p.ids.leaveDateA, { reason: 'Medical: confidential diagnosis' });
    await p.req('manager', 'POST', `${H}/leave/requests/${res.body.data?.id}/approve`, { expectedVersion: res.body.data?.version });
    const reason = await p.req('manager', 'GET', `${H}/leave/requests/${res.body.data?.id}/reason`);
    p.status('manager cannot read the medical reason', reason, [403]);
    const report = await p.req('manager', 'GET', `${H}/reports/leave?from=${p.ids.leaveDateA}&to=${p.ids.leaveDateA}`);
    p.check('reports never include reasons', !JSON.stringify(report.body).includes('diagnosis'), report.status);
  },
  async '11-hr-security-retention-and-analytics::AC02'(p) {
    const file = await seedDriveFile(p.db, p.f.workspaceId, p.w.users.hr.id, Buffer.from('id'), 'id.pdf');
    const bound = await p.req('hr', 'POST', `${H}/employees/${p.ids.employeeId}/documents/bind`, { fileId: file.id, category: 'ID', confidentiality: 'CONFIDENTIAL' });
    p.ok('legal hold placed', await p.req('hr', 'POST', `${H}/privacy/legal-holds`, { employeeId: p.ids.employeeId, reason: 'Litigation' }));
    const removed = await p.req('hr', 'DELETE', `${H}/employees/${p.ids.employeeId}/documents/${bound.body.data?.id}`);
    p.status('legal hold blocks deletion', removed, [409]);
    p.check('binding retained', (await p.q(db => db.hrDocumentBinding.findUniqueOrThrow({ where: { id: bound.body.data?.id } }))).removedAt === null);
  },
  async '11-hr-security-retention-and-analytics::AC03'(p) {
    const { HrJobsService } = await import('../../../src/server/hr/jobs-service');
    await p.call(() => new HrJobsService(p.db).tickAccessTransitions());
    const events = await p.obs('hr_work_events', { employeeId: p.ids.terminatedEmployeeId });
    p.check('attendance history retained after termination', events.length > 0);
    p.check('workspace membership revoked', (await p.q(db => db.workspaceMembership.findFirstOrThrow({ where: { workspaceId: p.f.workspaceId, userId: p.w.users.admin.id } }))).status === 'SUSPENDED');
    const live = await p.req('admin', 'GET', `${H}/me/work-sessions`);
    p.status('no live system access', live, [401, 403]);
  },
};
