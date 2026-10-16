import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors';
import { requirePermission, type Principal } from '../process-platform/context';
import { decrypt, encrypt } from '../suite/kernel';
import { enqueueJob, registerJob } from './events-service';
import { assertVersion, audit, emitEvent, notFound, pageQuery, paged, requirePlatform, type DbClient, type PlatformPrincipal, type Tx } from './kernel';

/**
 * Typed module hooks (rule 4): owning modules export/erase their own data; Platform only orchestrates.
 * Each call processes one bounded batch and returns the next checkpoint, so an interrupted job resumes
 * from the persisted checkpoint without repeating committed work (AC03).
 */
export type PrivacyHook = { moduleCode: string; category: string;
  export(tx: Tx, workspaceId: string, subjectRef: string, cursor: string | null): Promise<{ items: unknown[]; nextCursor: string | null }>;
  erase(tx: Tx, workspaceId: string, subjectRef: string, cursor: string | null): Promise<{ processed: number; nextCursor: string | null; retained?: string[] }> };
const hooks = new Map<string, PrivacyHook>();
export function registerPrivacyHook(hook: PrivacyHook) { hooks.set(hook.moduleCode, hook); }

/** Categories that need an effective jurisdiction policy before a Workspace may be activated for production (rule 1). */
export const REQUIRED_RETENTION_CATEGORIES = ['customer_records', 'financial_records', 'audit_logs', 'communications', 'knowledge_content', 'ai_conversations', 'hr_records'] as const;
const subjectRef = z.string().trim().regex(/^(email:[^\s@]+@[^\s@]+|contact:[0-9a-f-]{36}|user:[0-9a-f-]{36})$/i, 'subjectRef must be email:<address>, contact:<uuid> or user:<uuid>.').transform(v => v.startsWith('email:') ? v.toLowerCase() : v);
const PRIVACY_MACHINE: Record<string, string[]> = { RECEIVED: ['VALIDATED', 'DENIED'], VALIDATED: ['RUNNING', 'DENIED', 'COMPLETED'], RUNNING: ['COMPLETED', 'FAILED'], FAILED: ['RUNNING'] };
const EXPORT_TTL_DAYS = 7;

/** Legal hold has priority over deletion/anonymization (rule 2). A WORKSPACE-wide hold for the module (or `*`) blocks everything. */
export async function legalHoldActive(db: DbClient, workspaceId: string, module: string, scopeId?: string | null) {
  const hold = await db.suiteLegalHold.findFirst({ where: { workspaceId, releasedAt: null, module: { in: [module, '*'] }, OR: [{ scopeType: 'WORKSPACE' }, ...(scopeId ? [{ scopeId }] : [])] } });
  return Boolean(hold);
}
export async function assertNoLegalHold(db: DbClient, workspaceId: string, module: string, scopeId?: string | null) {
  if (await legalHoldActive(db, workspaceId, module, scopeId)) throw new AppError('LEGAL_HOLD_ACTIVE', 'A legal hold prevents this deletion.', 409);
}
/** Effective policy for a category/jurisdiction at `at`; null means "not configured" (never a guessed global duration). */
export async function effectiveRetention(db: DbClient, jurisdiction: string, category: string, at = new Date()) {
  return db.platformRetentionPolicy.findFirst({ where: { jurisdiction, category, effectiveFrom: { lte: at } }, orderBy: { effectiveFrom: 'desc' } });
}

registerJob({ type: 'platform.privacy.run', ownerModule: 'platform', maxAttempts: 8, async run(ctx) {
  const { prisma } = await import('../prisma-client');
  const requestId = String(ctx.payload.privacyRequestId);
  const request = await prisma.privacyRequest.findUnique({ where: { id: requestId } });
  if (!request || !['VALIDATED', 'RUNNING'].includes(request.status)) return { skipped: true };
  if (request.status === 'VALIDATED') await prisma.privacyRequest.update({ where: { id: requestId }, data: { status: 'RUNNING', version: { increment: 1 } } });
  for (const hook of hooks.values()) {
    const item = await prisma.privacyJobItem.upsert({ where: { requestId_moduleCode: { requestId, moduleCode: hook.moduleCode } }, create: { requestId, moduleCode: hook.moduleCode }, update: {} });
    if (['DONE', 'HELD'].includes(item.status)) continue;
    if (request.kind === 'ERASE' && await legalHoldActive(prisma, request.workspaceId, hook.moduleCode)) {
      await prisma.privacyJobItem.update({ where: { id: item.id }, data: { status: 'HELD', output: { reason: 'LEGAL_HOLD' } } }); continue;
    }
    let cursor = item.checkpoint;
    for (;;) {
      // Effect and checkpoint commit together: a crash between batches never repeats a committed batch.
      const step = await prisma.$transaction(async tx => {
        const current = await tx.privacyJobItem.findUniqueOrThrow({ where: { id: item.id } });
        if (current.checkpoint !== cursor) return { next: current.checkpoint, done: current.status === 'DONE' };
        if (request.kind === 'EXPORT') {
          const page = await hook.export(tx, request.workspaceId, request.subjectRef, cursor);
          const collected = [...((current.output as { items?: unknown[] } | null)?.items ?? []), ...page.items];
          await tx.privacyJobItem.update({ where: { id: item.id }, data: { checkpoint: page.nextCursor, processedCount: { increment: page.items.length }, output: { items: collected } as object, status: page.nextCursor ? 'RUNNING' : 'DONE' } });
          return { next: page.nextCursor, done: !page.nextCursor };
        }
        const result = await hook.erase(tx, request.workspaceId, request.subjectRef, cursor);
        const retained = [...((current.output as { retained?: string[] } | null)?.retained ?? []), ...(result.retained ?? [])];
        await tx.privacyJobItem.update({ where: { id: item.id }, data: { checkpoint: result.nextCursor, processedCount: { increment: result.processed }, output: { retained }, status: result.nextCursor ? 'RUNNING' : 'DONE' } });
        return { next: result.nextCursor, done: !result.nextCursor };
      }, { timeout: 60000 });
      if (step.done) break;
      cursor = step.next;
    }
  }
  await prisma.$transaction(async tx => {
    const items = await tx.privacyJobItem.findMany({ where: { requestId } });
    const held = items.filter(i => i.status === 'HELD').map(i => i.moduleCode);
    const output = request.kind === 'EXPORT' ? encrypt(JSON.stringify({ subjectRef: request.subjectRef, generatedAt: new Date().toISOString(), modules: Object.fromEntries(items.map(i => [i.moduleCode, (i.output as { items?: unknown[] } | null)?.items ?? []])) })) : null;
    if (request.kind === 'EXPORT') await tx.privacyJobItem.updateMany({ where: { requestId }, data: { output: { exported: true } } }); // the sealed bundle is the only copy
    const updated = await tx.privacyRequest.update({ where: { id: requestId }, data: { status: 'COMPLETED', completedAt: new Date(), version: { increment: 1 }, decisionReason: held.length ? `Retained under legal hold: ${held.join(', ')}` : request.decisionReason,
      ...(output ? { outputSealed: output, outputExpiresAt: new Date(Date.now() + EXPORT_TTL_DAYS * 86400000) } : {}) } });
    await audit(tx, { workspaceId: request.workspaceId, actorId: null, actorType: 'SERVICE', action: 'PRIVACY_REQUEST_COMPLETED', resourceType: 'PrivacyRequest', resourceId: requestId, after: { kind: request.kind, held, modules: items.length } });
    await emitEvent(tx, { workspaceId: request.workspaceId, eventType: 'PRIVACY_REQUEST_COMPLETED', aggregateType: 'PrivacyRequest', aggregateId: requestId, aggregateVersion: updated.version, actorType: 'SERVICE', payload: { kind: request.kind, held } });
  });
  return { completed: true };
} });

/** Privacy requests, retention policies, legal holds and activation readiness (30-Platform-Services/09). */
export class PlatformPrivacyService {
  constructor(private readonly db: PrismaClient) {}
  private sameWorkspace(actor: Principal, workspaceId: string) { if (workspaceId !== actor.workspaceId) throw notFound('Workspace'); }

  async submit(actor: Principal, workspaceId: string, raw: unknown, requestId: string) {
    this.sameWorkspace(actor, workspaceId); requirePermission(actor, 'privacy.request');
    const input = z.strictObject({ kind: z.enum(['EXPORT', 'ERASE', 'RECTIFY']), subjectRef, reason: z.string().trim().min(5).max(2000) }).parse(raw);
    return this.db.$transaction(async tx => {
      const row = await tx.privacyRequest.create({ data: { workspaceId, subjectRef: input.subjectRef, kind: input.kind, reason: input.reason, requestedBy: actor.userId } });
      await audit(tx, { workspaceId, actorId: actor.userId, action: 'PRIVACY_REQUEST_SUBMITTED', resourceType: 'PrivacyRequest', resourceId: row.id, after: { kind: row.kind }, requestId });
      await emitEvent(tx, { workspaceId, eventType: 'PRIVACY_REQUEST_SUBMITTED', aggregateType: 'PrivacyRequest', aggregateId: row.id, aggregateVersion: 1, actorId: actor.userId, payload: { kind: row.kind } });
      return { id: row.id, status: row.status, kind: row.kind };
    });
  }
  async list(actor: Principal, workspaceId: string, raw: unknown) {
    this.sameWorkspace(actor, workspaceId); requirePermission(actor, 'privacy.review');
    const q = pageQuery.extend({ status: z.enum(['RECEIVED', 'VALIDATED', 'RUNNING', 'COMPLETED', 'DENIED', 'FAILED']).optional() }).parse(raw);
    const where = { workspaceId, ...(q.status ? { status: q.status } : {}) };
    const [rows, total] = await Promise.all([this.db.privacyRequest.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit, omit: { outputSealed: true } }), this.db.privacyRequest.count({ where })]);
    return paged(rows, total, q.page, q.limit);
  }
  async get(actor: Principal, workspaceId: string, id: string) {
    this.sameWorkspace(actor, workspaceId);
    const row = await this.db.privacyRequest.findFirst({ where: { workspaceId, id: z.uuid().parse(id) }, omit: { outputSealed: true } });
    if (!row || (row.requestedBy !== actor.userId && !actor.grants.has('privacy.review'))) throw notFound('Privacy request');
    const items = await this.db.privacyJobItem.findMany({ where: { requestId: row.id }, select: { moduleCode: true, processedCount: true, errorCount: true, status: true } });
    return { ...row, items, exportAvailable: row.kind === 'EXPORT' && row.status === 'COMPLETED' && !!row.outputExpiresAt && row.outputExpiresAt > new Date() };
  }
  /** Reviewer verifies identity/legal basis, then approves (starts the job) or denies with a reason. */
  async decide(actor: Principal, workspaceId: string, id: string, raw: unknown, requestId: string) {
    this.sameWorkspace(actor, workspaceId); requirePermission(actor, 'privacy.review');
    const input = z.strictObject({ expectedVersion: z.number().int().positive(), decision: z.enum(['APPROVE', 'DENY', 'COMPLETE_RECTIFICATION']), identityVerified: z.boolean().default(false), reason: z.string().trim().min(3).max(2000) }).parse(raw);
    return this.db.$transaction(async tx => {
      const row = await tx.privacyRequest.findFirst({ where: { workspaceId, id: z.uuid().parse(id) } });
      if (!row) throw notFound('Privacy request');
      assertVersion(row.version, input.expectedVersion);
      if (row.requestedBy === actor.userId && input.decision === 'APPROVE' && row.kind === 'ERASE') throw new AppError('PERMISSION_DENIED', 'Erasure needs a reviewer other than the requester.', 403);
      let to: string;
      if (input.decision === 'DENY') to = 'DENIED';
      else if (input.decision === 'COMPLETE_RECTIFICATION') { if (row.kind !== 'RECTIFY' || row.status !== 'VALIDATED') throw new AppError('INVALID_STATE_TRANSITION', 'Only validated rectification requests can be completed.', 409); to = 'COMPLETED'; }
      else { if (!input.identityVerified) throw new AppError('BUSINESS_RULE_VIOLATION', 'Subject identity/legal basis must be verified first.', 422); to = 'VALIDATED'; }
      if (!(PRIVACY_MACHINE[row.status] ?? []).includes(to)) throw new AppError('INVALID_STATE_TRANSITION', `Request is ${row.status}.`, 409);
      const updated = await tx.privacyRequest.update({ where: { id: row.id }, data: { status: to, decisionReason: input.reason, reviewedBy: actor.userId, version: { increment: 1 },
        ...(to === 'VALIDATED' ? { identityVerifiedAt: new Date() } : {}), ...(to === 'COMPLETED' ? { completedAt: new Date() } : {}) } });
      if (to === 'VALIDATED' && row.kind !== 'RECTIFY') await enqueueJob(tx, { type: 'platform.privacy.run', ownerModule: 'platform', workspaceId, payload: { privacyRequestId: row.id }, idempotencyKey: 'privacy:' + row.id });
      await audit(tx, { workspaceId, actorId: actor.userId, action: to === 'DENIED' ? 'PRIVACY_REQUEST_DENIED' : to === 'COMPLETED' ? 'PRIVACY_REQUEST_COMPLETED' : 'PRIVACY_REQUEST_VALIDATED', resourceType: 'PrivacyRequest', resourceId: row.id, before: { status: row.status }, after: { status: to }, requestId });
      if (to === 'COMPLETED') await emitEvent(tx, { workspaceId, eventType: 'PRIVACY_REQUEST_COMPLETED', aggregateType: 'PrivacyRequest', aggregateId: row.id, aggregateVersion: updated.version, actorId: actor.userId, payload: { kind: row.kind } });
      return { id: row.id, status: updated.status, version: updated.version };
    });
  }
  /** Portable export bundle: only the subject's data from this Workspace, sealed at rest, time-limited. */
  async download(actor: Principal, workspaceId: string, id: string, requestId: string) {
    this.sameWorkspace(actor, workspaceId); requirePermission(actor, 'privacy.review');
    const row = await this.db.privacyRequest.findFirst({ where: { workspaceId, id: z.uuid().parse(id), kind: 'EXPORT', status: 'COMPLETED' } });
    if (!row?.outputSealed) throw notFound('Export');
    if (!row.outputExpiresAt || row.outputExpiresAt <= new Date()) throw new AppError('INVALID_STATE_TRANSITION', 'Export has expired.', 409);
    await this.db.$transaction(tx => audit(tx, { workspaceId, actorId: actor.userId, action: 'PRIVACY_EXPORT_DOWNLOADED', resourceType: 'PrivacyRequest', resourceId: row.id, requestId }));
    return JSON.parse(decrypt(row.outputSealed)!);
  }

  // ------------------------------------------------------------ retention policies (platform, versioned by effectiveFrom)
  async policies(actor: PlatformPrincipal, raw: unknown) {
    requirePlatform(actor, 'retention.manage');
    const q = pageQuery.extend({ jurisdiction: z.string().max(10).optional(), category: z.string().max(60).optional() }).parse(raw);
    const where = { ...(q.jurisdiction ? { jurisdiction: q.jurisdiction } : {}), ...(q.category ? { category: q.category } : {}) };
    const [rows, total] = await Promise.all([this.db.platformRetentionPolicy.findMany({ where, orderBy: [{ jurisdiction: 'asc' }, { category: 'asc' }, { effectiveFrom: 'desc' }], skip: (q.page - 1) * q.limit, take: q.limit }), this.db.platformRetentionPolicy.count({ where })]);
    return paged(rows, total, q.page, q.limit);
  }
  private policyInput = z.strictObject({ jurisdiction: z.string().regex(/^([A-Z]{2}(-[A-Z0-9]{1,3})?|EU|GLOBAL)$/), category: z.string().regex(/^[a-z][a-z_]{2,60}$/), durationDays: z.number().int().min(1).max(36500).nullable(),
    action: z.enum(['DELETE', 'ANONYMIZE', 'ARCHIVE']), legalBasis: z.string().trim().min(3).max(500), effectiveFrom: z.iso.datetime({ offset: true }) });
  async createPolicy(actor: PlatformPrincipal, raw: unknown, requestId: string) {
    requirePlatform(actor, 'retention.manage');
    const input = this.policyInput.parse(raw);
    return this.db.$transaction(async tx => {
      const row = await tx.platformRetentionPolicy.create({ data: { ...input, effectiveFrom: new Date(input.effectiveFrom), createdBy: actor.userId } });
      await audit(tx, { workspaceId: null, actorId: actor.userId, actorType: 'PLATFORM', action: 'RETENTION_POLICY_CREATED', resourceType: 'PlatformRetentionPolicy', resourceId: row.id, after: input, requestId });
      await emitEvent(tx, { workspaceId: null, eventType: 'RETENTION_POLICY_CHANGED', aggregateType: 'PlatformRetentionPolicy', aggregateId: row.id, aggregateVersion: 1, actorId: actor.userId, actorType: 'PLATFORM', payload: { jurisdiction: row.jurisdiction, category: row.category } });
      return row;
    });
  }
  /** Controlled change: an already-effective policy is immutable (publish a new effective version instead). */
  async patchPolicy(actor: PlatformPrincipal, id: string, raw: unknown, requestId: string) {
    requirePlatform(actor, 'retention.manage');
    const input = this.policyInput.partial().extend({ expectedVersion: z.number().int().positive() }).strict().parse(raw);
    return this.db.$transaction(async tx => {
      const row = await tx.platformRetentionPolicy.findUnique({ where: { id: z.uuid().parse(id) } });
      if (!row) throw notFound('Retention policy');
      assertVersion(row.version, input.expectedVersion);
      if (row.effectiveFrom <= new Date()) throw new AppError('INVALID_STATE_TRANSITION', 'Effective policies are immutable; create a new effective version.', 409);
      const { expectedVersion: _v, effectiveFrom, ...change } = input;
      const updated = await tx.platformRetentionPolicy.update({ where: { id: row.id }, data: { ...change, ...(effectiveFrom ? { effectiveFrom: new Date(effectiveFrom) } : {}), version: { increment: 1 } } });
      await audit(tx, { workspaceId: null, actorId: actor.userId, actorType: 'PLATFORM', action: 'RETENTION_POLICY_CHANGED', resourceType: 'PlatformRetentionPolicy', resourceId: row.id, before: row, after: updated, requestId });
      await emitEvent(tx, { workspaceId: null, eventType: 'RETENTION_POLICY_CHANGED', aggregateType: 'PlatformRetentionPolicy', aggregateId: row.id, aggregateVersion: updated.version, actorId: actor.userId, actorType: 'PLATFORM', payload: {} });
      return updated;
    });
  }

  // ------------------------------------------------------------ legal holds
  async holds(actor: Principal, workspaceId: string) {
    this.sameWorkspace(actor, workspaceId); requirePermission(actor, 'legalHold.manage');
    return this.db.suiteLegalHold.findMany({ where: { workspaceId }, orderBy: { placedAt: 'desc' }, take: 500 });
  }
  async applyHold(actor: Principal, workspaceId: string, raw: unknown, requestId: string) {
    this.sameWorkspace(actor, workspaceId); requirePermission(actor, 'legalHold.manage');
    const input = z.strictObject({ scope: z.strictObject({ module: z.string().regex(/^([a-z][a-z_.-]{1,40}|\*)$/), scopeType: z.enum(['WORKSPACE', 'RECORD', 'SUBJECT']), scopeId: z.uuid().optional() }),
      reason: z.string().trim().min(5).max(2000), authorityRef: z.string().trim().min(2).max(200) }).parse(raw);
    if (input.scope.scopeType !== 'WORKSPACE' && !input.scope.scopeId) throw new AppError('VALIDATION_FAILED', 'scopeId is required for record/subject holds.', 400, { fields: [{ field: 'scope.scopeId', reason: 'REQUIRED' }] });
    return this.db.$transaction(async tx => {
      const hold = await tx.suiteLegalHold.create({ data: { workspaceId, module: input.scope.module, scopeType: input.scope.scopeType, scopeId: input.scope.scopeId ?? null, reason: input.reason, authorityRef: input.authorityRef, placedByUserId: actor.userId } });
      await audit(tx, { workspaceId, actorId: actor.userId, action: 'LEGAL_HOLD_APPLIED', resourceType: 'LegalHold', resourceId: hold.id, after: { scope: input.scope, authorityRef: input.authorityRef }, requestId });
      await emitEvent(tx, { workspaceId, eventType: 'LEGAL_HOLD_APPLIED', aggregateType: 'LegalHold', aggregateId: hold.id, aggregateVersion: 1, actorId: actor.userId, payload: { module: hold.module, scopeType: hold.scopeType } });
      return hold;
    });
  }
  async releaseHold(actor: Principal, workspaceId: string, holdId: string, raw: unknown, requestId: string) {
    this.sameWorkspace(actor, workspaceId); requirePermission(actor, 'legalHold.manage');
    const input = z.strictObject({ reason: z.string().trim().min(5).max(2000) }).parse(raw);
    return this.db.$transaction(async tx => {
      const hold = await tx.suiteLegalHold.findFirst({ where: { workspaceId, id: z.uuid().parse(holdId) } });
      if (!hold) throw notFound('Legal hold');
      const released = await tx.suiteLegalHold.updateMany({ where: { id: hold.id, releasedAt: null }, data: { releasedAt: new Date(), releaseReason: input.reason, releasedByUserId: actor.userId } });
      if (!released.count) throw new AppError('INVALID_STATE_TRANSITION', 'Legal hold is already released.', 409);
      await audit(tx, { workspaceId, actorId: actor.userId, action: 'LEGAL_HOLD_RELEASED', resourceType: 'LegalHold', resourceId: hold.id, after: { reason: input.reason }, requestId });
      await emitEvent(tx, { workspaceId, eventType: 'LEGAL_HOLD_RELEASED', aggregateType: 'LegalHold', aggregateId: hold.id, aggregateVersion: 2, actorId: actor.userId, payload: { module: hold.module } });
      return { id: hold.id, released: true };
    });
  }

  // ------------------------------------------------------------ production activation readiness (AC05)
  static async readiness(db: DbClient, workspaceId: string) {
    const settings = await db.platformSetting.findUnique({ where: { key_scope_scopeId: { key: 'workspace', scope: 'WORKSPACE', scopeId: workspaceId } } });
    const jurisdiction = (settings?.value as { jurisdiction?: string } | undefined)?.jurisdiction ?? null;
    const missing: string[] = [];
    if (!jurisdiction) return { ready: false, jurisdiction, missing: ['jurisdiction'] };
    const parent = jurisdiction.split('-')[0];
    for (const category of REQUIRED_RETENTION_CATEGORIES) {
      const policy = await effectiveRetention(db, jurisdiction, category) ?? await effectiveRetention(db, parent, category);
      if (!policy) missing.push(category);
    }
    return { ready: missing.length === 0, jurisdiction, missing };
  }
  static async assertProductionReady(db: DbClient, workspaceId: string) {
    const result = await PlatformPrivacyService.readiness(db, workspaceId);
    if (!result.ready) throw new AppError('BUSINESS_RULE_VIOLATION', 'Retention policies must be configured for the Workspace jurisdiction before production activation.', 422, { missing: result.missing });
  }
  async readinessFor(actor: Principal, workspaceId: string) { this.sameWorkspace(actor, workspaceId); requirePermission(actor, 'workspace.settings.manage'); return PlatformPrivacyService.readiness(this.db, workspaceId); }
}
