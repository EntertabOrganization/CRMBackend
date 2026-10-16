import { createHmac } from 'node:crypto';
import type { HrEmployee, HrWorkEvent, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors';
import { parse, uuid } from '../process-platform/dto';
import { evidence, lock, requirePermission, type Principal, type Tx } from '../process-platform/context';
import { asDate, dateRange, encrypt, expectedVersion, inTx, localDate, localDateOf, notFound, safeEqual } from '../suite/kernel';
import { resolveSecret } from '../suite/providers';
import { myEmployee, readableEmployee, teamAuthority } from './support';
import { HrScheduleService } from './schedule-service';

const MAX_SKEW_MS = 5 * 60000;
const proof = z.strictObject({ gps: z.strictObject({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), accuracyMeters: z.number().min(0).max(10000).optional() }).optional(), qrCode: z.string().max(200).optional() });
const clockBody = z.strictObject({ source: z.enum(['WEB', 'MOBILE']).default('WEB'), evidence: proof.optional() });

/** Effective events: raw history is immutable; approved corrections append superseding events. */
export function effectiveEvents(events: HrWorkEvent[]) {
  const superseded = new Set(events.filter(e => e.supersedesEventId).map(e => e.supersedesEventId!));
  return events.filter(e => !superseded.has(e.id) && e.type !== 'VOID').sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
}
export function sessionMinutes(events: HrWorkEvent[]) {
  const eff = effectiveEvents(events), clockIn = eff.find(e => e.type === 'CLOCK_IN'), clockOut = [...eff].reverse().find(e => e.type === 'CLOCK_OUT');
  if (!clockIn || !clockOut || clockOut.occurredAt <= clockIn.occurredAt) return { worked: 0, unpaidBreak: 0, complete: false, start: clockIn?.occurredAt ?? null };
  let unpaidBreak = 0, open: Date | null = null;
  for (const e of eff) { if (e.type === 'BREAK_START') open = e.occurredAt; if (e.type === 'BREAK_END' && open) { unpaidBreak += Math.round((e.occurredAt.getTime() - open.getTime()) / 60000); open = null; } }
  const span = Math.round((clockOut.occurredAt.getTime() - clockIn.occurredAt.getTime()) / 60000);
  return { worked: Math.max(0, span - unpaidBreak), unpaidBreak, complete: true, start: clockIn.occurredAt };
}
function ipInCidr(ip: string, cidr: string) {
  const [net, bits] = cidr.split('/'), toInt = (v: string) => v.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) return false;
  const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return (toInt(ip) & mask) === (toInt(net) & mask);
}
function distanceMeters(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const r = 6371000, rad = (d: number) => d * Math.PI / 180, dLat = rad(b.latitude - a.latitude), dLng = rad(b.longitude - a.longitude);
  return 2 * r * Math.asin(Math.sqrt(Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2));
}

/** Clock/break work sessions, attendance evaluation and corrections (specs HR/03, HR/04). */
export class HrWorktimeService {
  constructor(private readonly db: PrismaClient) {}

  /** Optional IP/GPS/QR checks only where the work-location policy requires them; nothing is stored otherwise (no continuous tracking). */
  private async verify(tx: Tx, employee: HrEmployee, clientIp: string, input: z.infer<typeof clockBody>) {
    const location = employee.workLocationId ? await tx.hrWorkLocation.findFirst({ where: { workspaceId: employee.workspaceId, id: employee.workLocationId } }) : null;
    const captured: { kind: string; payload: string }[] = [];
    if (!location) return captured;
    const networks = location.allowedNetworks as string[];
    if (networks.length) { if (!networks.some(c => ipInCidr(clientIp, c))) throw new AppError('ATTENDANCE_VERIFICATION_FAILED', 'Clocking is only allowed from approved networks.', 409); captured.push({ kind: 'NETWORK', payload: encrypt(JSON.stringify({ ip: clientIp })) }); }
    const geo = location.geoRules as { latitude: number; longitude: number; radiusMeters: number } | null;
    if (geo) {
      if (!input.evidence?.gps) throw new AppError('ATTENDANCE_VERIFICATION_FAILED', 'Location evidence is required at this work location.', 409);
      if (distanceMeters(geo, input.evidence.gps) > geo.radiusMeters) throw new AppError('ATTENDANCE_VERIFICATION_FAILED', 'Location is outside the permitted area.', 409);
      captured.push({ kind: 'GPS', payload: encrypt(JSON.stringify(input.evidence.gps)) });
    }
    if (location.qrRequired) {
      let secret: string; try { secret = resolveSecret(location.qrSecretRef); } catch { throw new AppError('DEPENDENCY_UNAVAILABLE', 'QR verification is unavailable.', 503); }
      const window = Math.floor(Date.now() / 300000), valid = [window, window - 1].some(w => input.evidence?.qrCode && safeEqual(input.evidence.qrCode, createHmac('sha256', secret).update(location.id + ':' + w).digest('hex').slice(0, 16)));
      if (!valid) throw new AppError('ATTENDANCE_VERIFICATION_FAILED', 'QR code is invalid or expired.', 409);
      captured.push({ kind: 'QR', payload: encrypt(JSON.stringify({ window })) });
    }
    return captured;
  }
  private async event(tx: Tx, actor: Principal, employee: HrEmployee, sessionId: string, type: string, source: string, key: string | null, captured: { kind: string; payload: string }[] = []) {
    const row = await tx.hrWorkEvent.create({ data: { workspaceId: actor.workspaceId, employeeId: employee.id, sessionId, type, occurredAt: new Date(), source, idempotencyKey: key, recordedByUserId: actor.userId } });
    for (const c of captured) await tx.hrAttendanceEvidence.create({ data: { workspaceId: actor.workspaceId, eventId: row.id, kind: c.kind, encryptedPayload: c.payload } });
    return row;
  }
  private async replay(tx: Tx, employee: HrEmployee, key: string | null) {
    if (!key) return null;
    if (key.length < 8 || key.length > 128) throw new AppError('VALIDATION_FAILED', 'Idempotency-Key must contain 8 to 128 characters.', 400);
    const prior = await tx.hrWorkEvent.findUnique({ where: { workspaceId_employeeId_idempotencyKey: { workspaceId: employee.workspaceId, employeeId: employee.id, idempotencyKey: key } } });
    return prior ? tx.hrWorkSession.findUniqueOrThrow({ where: { id: prior.sessionId } }) : null;
  }

  async clock(actor: Principal, action: 'CLOCK_IN' | 'CLOCK_OUT' | 'BREAK_START' | 'BREAK_END', raw: unknown, key: string | null, clientIp: string) {
    const input = parse(clockBody, raw ?? {});
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'hr.worktime.clock_self');
      const employee = await myEmployee(tx, actor) as HrEmployee;
      await lock(tx, actor.workspaceId, 'hr:worktime:' + employee.id);
      const replay = await this.replay(tx, employee, key); if (replay) return replay;
      const open = await tx.hrWorkSession.findFirst({ where: { workspaceId: actor.workspaceId, employeeId: employee.id, status: 'OPEN' } });
      if (action === 'CLOCK_IN') {
        if (open) throw new AppError('INVALID_STATE_TRANSITION', 'A work session is already open.', 409);
        const captured = await this.verify(tx, employee, clientIp, input);
        const session = await tx.hrWorkSession.create({ data: { workspaceId: actor.workspaceId, employeeId: employee.id, startedAt: new Date(), source: input.source } });
        await this.event(tx, actor, employee, session.id, 'CLOCK_IN', input.source, key, captured);
        await evidence(tx, actor, 'HR_WORK_SESSION', session.id, 'CLOCK_IN_RECORDED', { employeeId: employee.id, evidenceKinds: captured.map(c => c.kind) });
        return session;
      }
      if (!open) throw new AppError('INVALID_STATE_TRANSITION', 'No open work session.', 409);
      const openBreak = await tx.hrBreak.findFirst({ where: { workspaceId: actor.workspaceId, sessionId: open.id, endedAt: null } });
      if (action === 'BREAK_START') {
        if (openBreak) throw new AppError('INVALID_STATE_TRANSITION', 'A break is already running.', 409);
        await tx.hrBreak.create({ data: { workspaceId: actor.workspaceId, sessionId: open.id, startedAt: new Date() } });
        await this.event(tx, actor, employee, open.id, 'BREAK_START', input.source, key);
        await evidence(tx, actor, 'HR_WORK_SESSION', open.id, 'BREAK_RECORDED', { phase: 'START' });
        return open;
      }
      if (action === 'BREAK_END') {
        if (!openBreak) throw new AppError('INVALID_STATE_TRANSITION', 'No break is running.', 409);
        await tx.hrBreak.update({ where: { id: openBreak.id }, data: { endedAt: new Date() } });
        await this.event(tx, actor, employee, open.id, 'BREAK_END', input.source, key);
        await evidence(tx, actor, 'HR_WORK_SESSION', open.id, 'BREAK_RECORDED', { phase: 'END' });
        return open;
      }
      if (openBreak) { await tx.hrBreak.update({ where: { id: openBreak.id }, data: { endedAt: new Date() } }); await this.event(tx, actor, employee, open.id, 'BREAK_END', input.source, null); }
      const captured = await this.verify(tx, employee, clientIp, input);
      await this.event(tx, actor, employee, open.id, 'CLOCK_OUT', input.source, key, captured);
      const closed = await tx.hrWorkSession.update({ where: { id: open.id }, data: { status: 'CLOSED', endedAt: new Date(), version: { increment: 1 } } });
      await evidence(tx, actor, 'HR_WORK_SESSION', open.id, 'CLOCK_OUT_RECORDED', { employeeId: employee.id });
      return closed;
    });
  }

  async sessions(actor: Principal, employeeId: string | null, raw: unknown) {
    const q = parse(z.object({ from: localDate.optional(), to: localDate.optional() }).passthrough(), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      const employee = employeeId ? (await readableEmployee(tx, actor, parse(uuid, employeeId))).employee : await myEmployee(tx, actor) as HrEmployee;
      if (employeeId && employee.userId !== actor.userId && !await teamAuthority(tx, actor, employee, 'hr.attendance.approve_team') && !actor.grants.has('hr.attendance.override_all')) throw notFound('Employee');
      const from = q.from ? asDate(q.from) : new Date(Date.now() - 31 * 86400000), to = q.to ? new Date(asDate(q.to).getTime() + 86400000) : new Date(Date.now() + 86400000);
      const sessions = await tx.hrWorkSession.findMany({ where: { workspaceId: actor.workspaceId, employeeId: employee.id, startedAt: { gte: from, lt: to } }, orderBy: { startedAt: 'desc' } });
      const events = await tx.hrWorkEvent.findMany({ where: { workspaceId: actor.workspaceId, sessionId: { in: sessions.map(s => s.id) } }, orderBy: { occurredAt: 'asc' } });
      const showEvidence = actor.grants.has('hr.attendance.evidence.read');
      return sessions.map(s => { const own = events.filter(e => e.sessionId === s.id), m = sessionMinutes(own);
        return { ...s, workedMinutes: m.worked, unpaidBreakMinutes: m.unpaidBreak, events: own.map(e => ({ id: e.id, type: e.type, occurredAt: e.occurredAt, source: e.source, correctionId: e.correctionId, supersedesEventId: e.supersedesEventId })), evidenceVisible: showEvidence }; });
    });
  }

  /** Authorized import (e.g. terminal/offline). Conflicts with existing sessions require supervisor review via corrections. */
  async importEvents(actor: Principal, raw: unknown) {
    const input = parse(z.strictObject({ events: z.array(z.strictObject({ employeeId: uuid, type: z.enum(['CLOCK_IN', 'CLOCK_OUT']), occurredAt: z.iso.datetime({ offset: true }), externalId: z.string().min(1).max(120) })).min(1).max(1000) }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'hr.worktime.record_other');
      let imported = 0, duplicates = 0, conflicts = 0;
      for (const e of [...input.events].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))) {
        const employee = await tx.hrEmployee.findFirst({ where: { workspaceId: actor.workspaceId, id: e.employeeId } });
        if (!employee) throw notFound('Employee');
        if (actor.grants.get('hr.worktime.record_other') !== 'WORKSPACE' && !await teamAuthority(tx, actor, employee, 'hr.worktime.record_other')) throw notFound('Employee');
        const key = 'import:' + e.externalId;
        if (await tx.hrWorkEvent.findUnique({ where: { workspaceId_employeeId_idempotencyKey: { workspaceId: actor.workspaceId, employeeId: employee.id, idempotencyKey: key } } })) { duplicates++; continue; }
        const at = new Date(e.occurredAt);
        if (at.getTime() > Date.now() + MAX_SKEW_MS) throw new AppError('VALIDATION_FAILED', 'Future clock events are rejected.', 400);
        const open = await tx.hrWorkSession.findFirst({ where: { workspaceId: actor.workspaceId, employeeId: employee.id, status: 'OPEN' } });
        if (e.type === 'CLOCK_IN') {
          if (open) { conflicts++; continue; }
          const session = await tx.hrWorkSession.create({ data: { workspaceId: actor.workspaceId, employeeId: employee.id, startedAt: at, source: 'IMPORT' } });
          await tx.hrWorkEvent.create({ data: { workspaceId: actor.workspaceId, employeeId: employee.id, sessionId: session.id, type: 'CLOCK_IN', occurredAt: at, source: 'IMPORT', idempotencyKey: key, recordedByUserId: actor.userId } });
        } else {
          if (!open || open.startedAt >= at) { conflicts++; continue; }
          await tx.hrWorkEvent.create({ data: { workspaceId: actor.workspaceId, employeeId: employee.id, sessionId: open.id, type: 'CLOCK_OUT', occurredAt: at, source: 'IMPORT', idempotencyKey: key, recordedByUserId: actor.userId } });
          await tx.hrWorkSession.update({ where: { id: open.id }, data: { status: 'CLOSED', endedAt: at, version: { increment: 1 } } });
        }
        imported++;
      }
      await evidence(tx, actor, 'HR_WORKTIME_IMPORT', actor.userId, 'CLOCK_EVENTS_IMPORTED', { imported, duplicates, conflicts });
      return { imported, duplicates, conflictsRequiringReview: conflicts };
    });
  }

  /** Attendance = immutable effective events + effective schedule + approved leave (recomputed, policy-versioned thresholds). */
  static async attendanceDays(tx: Tx, employee: HrEmployee, from: string, to: string, lateGraceMinutes = 5) {
    const expected = await HrScheduleService.expected(tx, employee, from, to);
    const sessions = await tx.hrWorkSession.findMany({ where: { workspaceId: employee.workspaceId, employeeId: employee.id, startedAt: { gte: new Date(asDate(from).getTime() - 86400000), lt: new Date(asDate(to).getTime() + 2 * 86400000) } } });
    const events = await tx.hrWorkEvent.findMany({ where: { workspaceId: employee.workspaceId, sessionId: { in: sessions.map(s => s.id) } } });
    const leaves = await tx.hrLeaveRequest.findMany({ where: { workspaceId: employee.workspaceId, employeeId: employee.id, status: 'APPROVED', fromLocal: { lte: asDate(to) }, toLocal: { gte: asDate(from) } } });
    return dateRange(from, to).map(date => {
      const periods = expected.filter(p => p.date === date), expectedMinutes = periods.reduce((s, p) => s + p.minutes, 0);
      const own = sessions.filter(s => localDateOf(s.startedAt, employee.timezone) === date);
      let worked = 0, breaks = 0, incomplete = false, firstIn: Date | null = null;
      for (const s of own) { const m = sessionMinutes(events.filter(e => e.sessionId === s.id)); worked += m.worked; breaks += m.unpaidBreak; if (!m.complete || s.status === 'INCOMPLETE') incomplete = true; if (m.start && (!firstIn || m.start < firstIn)) firstIn = m.start; }
      const onLeave = leaves.find(l => l.fromLocal.toISOString().slice(0, 10) <= date && l.toLocal.toISOString().slice(0, 10) >= date);
      const lateMinutes = firstIn && periods[0] ? Math.max(0, Math.round((firstIn.getTime() - periods[0].startAt.getTime()) / 60000)) : 0;
      const status = incomplete ? 'ANOMALY' : onLeave ? 'EXCUSED' : expectedMinutes > 0 && !own.length ? (date < new Date().toISOString().slice(0, 10) ? 'ABSENT' : 'MISSING') : lateMinutes > lateGraceMinutes ? 'LATE' : 'NORMAL';
      return { date, expectedMinutes, workedMinutes: worked, breakMinutes: breaks, lateMinutes, leaveMinutes: onLeave ? (onLeave.partDayMinutes ?? expectedMinutes) : 0, status, sessionIds: own.map(s => s.id), policy: { lateGraceMinutes, version: 1 } };
    });
  }
  async attendance(actor: Principal, employeeId: string, raw: unknown) {
    const q = parse(z.object({ from: localDate, to: localDate }).passthrough(), raw);
    if (dateRange(q.from, q.to).length > 93) throw new AppError('VALIDATION_FAILED', 'Range is limited to 93 days.', 400);
    return inTx(this.db, actor, async (tx, actor) => {
      const { employee, access } = await readableEmployee(tx, actor, parse(uuid, employeeId));
      if (access !== 'SELF' && access !== 'ALL' && !await teamAuthority(tx, actor, employee, 'hr.attendance.approve_team')) throw notFound('Employee');
      return HrWorktimeService.attendanceDays(tx, employee, q.from, q.to);
    });
  }
  async anomalies(actor: Principal, raw: unknown) {
    const q = parse(z.object({ from: localDate.optional(), to: localDate.optional() }).passthrough(), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      if (!actor.grants.has('hr.attendance.override_all')) requirePermission(actor, 'hr.attendance.approve_team');
      const to = q.to ?? new Date().toISOString().slice(0, 10), from = q.from ?? new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
      const employees = await tx.hrEmployee.findMany({ where: { workspaceId: actor.workspaceId, status: { in: ['ACTIVE', 'ON_LEAVE'] } } });
      const out = [];
      for (const e of employees) {
        if (!actor.grants.has('hr.attendance.override_all') && !await teamAuthority(tx, actor, e, 'hr.attendance.approve_team')) continue;
        for (const day of await HrWorktimeService.attendanceDays(tx, e, from, to)) if (['ANOMALY', 'MISSING', 'ABSENT'].includes(day.status)) out.push({ employeeId: e.id, displayName: e.displayName, ...day });
        if (out.length > 1000) break;
      }
      return out;
    });
  }

  // ------------------------------------------------------------------ corrections
  async requestCorrection(actor: Principal, raw: unknown) {
    const input = parse(z.strictObject({ employeeId: uuid, workSessionId: uuid.optional(), targetDate: localDate.optional(), proposedEvents: z.array(z.strictObject({ type: z.enum(['CLOCK_IN', 'CLOCK_OUT', 'BREAK_START', 'BREAK_END']), occurredAt: z.iso.datetime({ offset: true }) })).min(1).max(10), reason: z.string().trim().min(1).max(1000) }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      const employee = await tx.hrEmployee.findFirst({ where: { workspaceId: actor.workspaceId, id: input.employeeId } });
      if (!employee) throw notFound('Employee');
      const self = employee.userId === actor.userId;
      if (self) requirePermission(actor, 'hr.attendance.request');
      else if (!await teamAuthority(tx, actor, employee, 'hr.attendance.approve_team') && !actor.grants.has('hr.attendance.override_all')) throw notFound('Employee');
      const session = input.workSessionId ? await tx.hrWorkSession.findFirst({ where: { workspaceId: actor.workspaceId, id: input.workSessionId, employeeId: employee.id } }) : null;
      if (input.workSessionId && !session) throw notFound('Work session');
      if (input.proposedEvents.some(e => new Date(e.occurredAt).getTime() > Date.now() + MAX_SKEW_MS)) throw new AppError('VALIDATION_FAILED', 'Corrections cannot be in the future.', 400);
      const targetDate = input.targetDate ?? (session ? localDateOf(session.startedAt, employee.timezone) : localDateOf(new Date(input.proposedEvents[0].occurredAt), employee.timezone));
      await this.assertNotLocked(tx, employee, targetDate);
      const row = await tx.hrAttendanceCorrection.create({ data: { workspaceId: actor.workspaceId, employeeId: employee.id, workSessionId: session?.id, targetDate: asDate(targetDate), proposedEvents: input.proposedEvents, reasonSealed: encrypt(input.reason), requestedByUserId: actor.userId } });
      await evidence(tx, actor, 'HR_ATTENDANCE_CORRECTION', row.id, 'ATTENDANCE_CORRECTION_REQUESTED', { employeeId: employee.id, targetDate });
      return { id: row.id, status: row.status, employeeId: employee.id, workSessionId: row.workSessionId, targetDate, version: row.version };
    });
  }
  private async assertNotLocked(tx: Tx, employee: HrEmployee, date: string) {
    if (await tx.hrTimesheet.findFirst({ where: { workspaceId: employee.workspaceId, employeeId: employee.id, status: { in: ['SUBMITTED', 'APPROVED', 'LOCKED'] }, periodStart: { lte: asDate(date) }, periodEnd: { gte: asDate(date) } } }))
      throw new AppError('TIMESHEET_LOCKED', 'The timesheet period is finalized; an authorized reopen is required first.', 409);
  }
  async decide(actor: Principal, id: string, raw: unknown, decision: 'APPROVE' | 'REJECT' | 'OVERRIDE') {
    const input = parse(z.strictObject({ expectedVersion, comment: z.string().trim().max(1000).optional(), reason: z.string().trim().min(1).max(1000).optional() }), raw);
    if (decision === 'OVERRIDE' && !input.reason) throw new AppError('VALIDATION_FAILED', 'HR override requires a reason.', 400, { fields: [{ field: 'reason', reason: 'REQUIRED' }] });
    return inTx(this.db, actor, async (tx, actor) => {
      await lock(tx, actor.workspaceId, 'hr:correction:' + id);
      const row = await tx.hrAttendanceCorrection.findFirst({ where: { workspaceId: actor.workspaceId, id: parse(uuid, id) } });
      if (!row) throw notFound('Correction');
      const employee = await tx.hrEmployee.findUniqueOrThrow({ where: { id: row.employeeId } });
      if (decision === 'OVERRIDE') requirePermission(actor, 'hr.attendance.override_all');
      else if (!await teamAuthority(tx, actor, employee, 'hr.attendance.approve_team')) throw new AppError('PERMISSION_DENIED', 'Not authorized to review this employee.', 403);
      if (employee.userId === actor.userId || row.requestedByUserId === actor.userId && decision !== 'OVERRIDE') throw new AppError('PERMISSION_DENIED', 'Requesters cannot approve their own correction.', 403);
      if (row.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT', 'Correction changed; reload.', 409);
      if (row.status !== 'REQUESTED' && !(decision === 'OVERRIDE' && row.status === 'REJECTED')) throw new AppError('INVALID_STATE_TRANSITION', `Correction is already ${row.status}.`, 409);
      if (decision === 'REJECT') {
        const updated = await tx.hrAttendanceCorrection.update({ where: { id: row.id }, data: { status: 'REJECTED', reviewedByUserId: actor.userId, reviewedAt: new Date(), version: { increment: 1 } } });
        await evidence(tx, actor, 'HR_ATTENDANCE_CORRECTION', row.id, 'ATTENDANCE_CORRECTION_REJECTED', {}); return updated;
      }
      await this.assertNotLocked(tx, employee, row.targetDate.toISOString().slice(0, 10));
      return this.apply(tx, actor, row.id, decision === 'OVERRIDE');
    });
  }
  /** APPROVED -> APPLIED exactly once: superseding events are appended; originals remain queryable. */
  private async apply(tx: Tx, actor: Principal, id: string, override: boolean) {
    const row = await tx.hrAttendanceCorrection.findUniqueOrThrow({ where: { id } });
    if (await tx.hrCorrectionHistory.findUnique({ where: { correctionId: id } })) return row;
    const employee = await tx.hrEmployee.findUniqueOrThrow({ where: { id: row.employeeId } });
    let session = row.workSessionId ? await tx.hrWorkSession.findUniqueOrThrow({ where: { id: row.workSessionId } }) : null;
    const proposed = (row.proposedEvents as { type: string; occurredAt: string }[]).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    if (!session) session = await tx.hrWorkSession.create({ data: { workspaceId: actor.workspaceId, employeeId: employee.id, startedAt: new Date(proposed[0].occurredAt), source: 'CORRECTION', status: 'INCOMPLETE' } });
    const before = effectiveEvents(await tx.hrWorkEvent.findMany({ where: { sessionId: session.id } }));
    for (const p of proposed) {
      const replaced = ['CLOCK_IN', 'CLOCK_OUT'].includes(p.type) ? before.find(e => e.type === p.type) : undefined;
      await tx.hrWorkEvent.create({ data: { workspaceId: actor.workspaceId, employeeId: employee.id, sessionId: session.id, type: p.type, occurredAt: new Date(p.occurredAt), source: 'CORRECTION', correctionId: row.id, supersedesEventId: replaced?.id, recordedByUserId: actor.userId } });
    }
    const after = effectiveEvents(await tx.hrWorkEvent.findMany({ where: { sessionId: session.id } }));
    const clockIn = after.find(e => e.type === 'CLOCK_IN'), clockOut = [...after].reverse().find(e => e.type === 'CLOCK_OUT');
    await tx.hrWorkSession.update({ where: { id: session.id }, data: { status: clockIn && clockOut ? 'CLOSED' : session.status === 'OPEN' ? 'OPEN' : 'INCOMPLETE', startedAt: clockIn?.occurredAt ?? session.startedAt, endedAt: clockOut?.occurredAt ?? null, version: { increment: 1 } } });
    await tx.hrCorrectionHistory.create({ data: { workspaceId: actor.workspaceId, correctionId: row.id, before: before.map(e => ({ id: e.id, type: e.type, occurredAt: e.occurredAt })), after: after.map(e => ({ id: e.id, type: e.type, occurredAt: e.occurredAt })), actorUserId: actor.userId } });
    const updated = await tx.hrAttendanceCorrection.update({ where: { id: row.id }, data: { status: 'APPLIED', workSessionId: session.id, reviewedByUserId: actor.userId, reviewedAt: new Date(), appliedAt: new Date(), override, version: { increment: 1 } } });
    await evidence(tx, actor, 'HR_ATTENDANCE_CORRECTION', row.id, 'ATTENDANCE_CORRECTION_APPROVED', { override });
    await evidence(tx, actor, 'HR_ATTENDANCE_CORRECTION', row.id, 'ATTENDANCE_CORRECTION_APPLIED', { sessionId: session.id });
    return updated;
  }
  async corrections(actor: Principal, raw: unknown) {
    const q = parse(z.object({ status: z.string().optional() }).passthrough(), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      const rows = await tx.hrAttendanceCorrection.findMany({ where: { workspaceId: actor.workspaceId, ...(q.status ? { status: q.status } : {}) }, orderBy: { createdAt: 'desc' }, take: 500 });
      const out = [];
      for (const r of rows) {
        const e = await tx.hrEmployee.findUniqueOrThrow({ where: { id: r.employeeId } });
        if (e.userId === actor.userId || actor.grants.has('hr.attendance.override_all') || await teamAuthority(tx, actor, e, 'hr.attendance.approve_team'))
          out.push({ id: r.id, employeeId: r.employeeId, workSessionId: r.workSessionId, targetDate: r.targetDate, proposedEvents: r.proposedEvents, status: r.status, version: r.version, createdAt: r.createdAt, reason: actor.grants.has('hr.attendance.override_all') || e.userId === actor.userId ? '[available on request detail]' : undefined });
      }
      return out;
    });
  }
}
