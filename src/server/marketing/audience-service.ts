import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors';
import { parse, uuid } from '../process-platform/dto';
import { evidence, requirePermission, type Principal } from '../process-platform/context';
import { encodeCsv, parseCsv } from '../process-platform/csv';
import { assertVersion, encrypt, expectedVersion, inTx, listQuery, maskDestination, paged, sha256, decrypt, normalizeDestination, destinationHash, notFound } from '../suite/kernel';
import { readCleanFile } from '../suite/files-port';
import { channel, loadSegment, resolveSegment, ruleTree, type Channel } from './support';

const segmentCreate = z.strictObject({ name: z.string().trim().min(1).max(160), kind: z.enum(['STATIC', 'DYNAMIC']), channel: channel.default('EMAIL'), ruleTree: ruleTree.optional(), exclusions: z.array(uuid).max(20).default([]) })
  .refine(v => v.kind === 'STATIC' || v.ruleTree, 'Dynamic segments require a rule tree');
const PROHIBITED_COLUMNS = /^(password|ssn|national_?id|passport|card|cvv|iban|health|diagnosis|religion|ethnicity)/i;

/** Segments, audience imports and frozen snapshots (specs Marketing/01, 02). */
export class MarketingAudienceService {
  constructor(private readonly db: PrismaClient) {}

  async createSegment(actor: Principal, raw: unknown) {
    const input = parse(segmentCreate, raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'marketing.segment.create');
      for (const id of input.exclusions) await loadSegment(tx, actor, id, 'marketing.segment.read');
      const row = await tx.marketingSegment.create({ data: { workspaceId: actor.workspaceId, name: input.name, kind: input.kind, channel: input.channel, ruleTree: (input.ruleTree ?? {}) as Prisma.InputJsonValue, exclusions: input.exclusions, status: 'ACTIVE', ownerUserId: actor.userId } });
      await evidence(tx, actor, 'MARKETING_SEGMENT', row.id, 'SEGMENT_CHANGED', { action: 'CREATED', kind: row.kind, revision: row.revision });
      return row;
    });
  }
  async listSegments(actor: Principal, raw: unknown) {
    const q = parse(listQuery, raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'marketing.segment.read');
      const rows = await tx.marketingSegment.findMany({ where: { workspaceId: actor.workspaceId, status: q.status ?? { not: 'ARCHIVED' }, ...(q.search ? { name: { contains: q.search, mode: 'insensitive' } } : {}) }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] });
      const visible = []; for (const r of rows) try { visible.push(await loadSegment(tx, actor, r.id, 'marketing.segment.read')); } catch { /* scope */ }
      return paged(visible.slice((q.page - 1) * q.limit, q.page * q.limit), visible.length, q.page, q.limit);
    });
  }
  async getSegment(actor: Principal, id: string) {
    return inTx(this.db, actor, async (tx, actor) => {
      const row = await loadSegment(tx, actor, parse(uuid, id), 'marketing.segment.read');
      const members = await tx.marketingSegmentMember.count({ where: { workspaceId: actor.workspaceId, segmentId: id, removedAt: null } });
      return { ...row, staticMemberCount: row.kind === 'STATIC' ? members : null };
    });
  }
  async patchSegment(actor: Principal, id: string, raw: unknown) {
    const input = parse(z.strictObject({ expectedVersion, name: z.string().trim().min(1).max(160).optional(), ruleTree: ruleTree.optional(), exclusions: z.array(uuid).max(20).optional(), status: z.enum(['ACTIVE', 'ARCHIVED']).optional() }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      const row = await loadSegment(tx, actor, parse(uuid, id), 'marketing.segment.edit'); assertVersion(row.version, input.expectedVersion);
      if (input.ruleTree && row.kind !== 'DYNAMIC') throw new AppError('VALIDATION_FAILED', 'Static segments change only through explicit membership changes.', 400);
      for (const ex of input.exclusions ?? []) { if (ex === id) throw new AppError('VALIDATION_FAILED', 'A segment cannot exclude itself.', 400); await loadSegment(tx, actor, ex, 'marketing.segment.read'); }
      const material = input.ruleTree !== undefined || input.exclusions !== undefined;
      const updated = await tx.marketingSegment.update({ where: { id }, data: { name: input.name, status: input.status, ...(input.ruleTree ? { ruleTree: input.ruleTree as Prisma.InputJsonValue } : {}), ...(input.exclusions ? { exclusions: input.exclusions } : {}), revision: material ? { increment: 1 } : undefined, version: { increment: 1 } } });
      await evidence(tx, actor, 'MARKETING_SEGMENT', id, 'SEGMENT_CHANGED', { action: 'UPDATED', revision: updated.revision });
      return updated;
    });
  }
  async members(actor: Principal, id: string, raw: unknown, action: 'ADD' | 'REMOVE') {
    const input = parse(z.strictObject({ contactIds: z.array(uuid).max(1000).default([]), audienceIdentityIds: z.array(uuid).max(1000).default([]) }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      const segment = await loadSegment(tx, actor, parse(uuid, id), 'marketing.segment.edit');
      if (segment.kind !== 'STATIC') throw new AppError('VALIDATION_FAILED', 'Dynamic segment membership is rule-based.', 400);
      requirePermission(actor, 'crm.contact.read');
      const contacts = input.contactIds.length ? await tx.crmContact.count({ where: { workspaceId: actor.workspaceId, id: { in: input.contactIds }, isDeleted: false } }) : 0;
      const identities = input.audienceIdentityIds.length ? await tx.marketingAudienceIdentity.count({ where: { workspaceId: actor.workspaceId, id: { in: input.audienceIdentityIds } } }) : 0;
      if (contacts !== input.contactIds.length || identities !== input.audienceIdentityIds.length) throw notFound('Member reference'); // cross-workspace ids never resolve
      const refs = [...input.contactIds.map(i => 'CONTACT:' + i), ...input.audienceIdentityIds.map(i => 'AUDIENCE:' + i)];
      for (const ref of refs) {
        if (action === 'ADD') await tx.marketingSegmentMember.upsert({ where: { segmentId_identityRef: { segmentId: id, identityRef: ref } }, create: { workspaceId: actor.workspaceId, segmentId: id, identityRef: ref, source: 'MANUAL' }, update: { removedAt: null } });
        else await tx.marketingSegmentMember.updateMany({ where: { workspaceId: actor.workspaceId, segmentId: id, identityRef: ref, removedAt: null }, data: { removedAt: new Date() } });
      }
      const updated = await tx.marketingSegment.update({ where: { id }, data: { revision: { increment: 1 }, version: { increment: 1 } } });
      await evidence(tx, actor, 'MARKETING_SEGMENT', id, 'SEGMENT_CHANGED', { action: 'MEMBERS_' + action, count: refs.length, revision: updated.revision });
      return { segmentId: id, changed: refs.length, revision: updated.revision };
    });
  }
  /** Aggregated preview; raw destinations only with marketing.audience.export. */
  async preview(actor: Principal, id: string) {
    return inTx(this.db, actor, async (tx, actor) => {
      const segment = await loadSegment(tx, actor, parse(uuid, id), 'marketing.segment.read');
      const members = await resolveSegment(tx, actor, segment);
      let suppressed = 0;
      for (const hash of members.keys()) if (await tx.marketingSuppression.findFirst({ where: { workspaceId: actor.workspaceId, destinationHash: hash, channel: { in: [segment.channel, 'ALL'] }, liftedAt: null } })) suppressed++;
      return { segmentId: id, revision: segment.revision, channel: segment.channel, count: members.size, suppressed, sources: { crm: [...members.values()].filter(m => m.ref.startsWith('CONTACT:')).length, imported: [...members.values()].filter(m => m.ref.startsWith('AUDIENCE:')).length }, evaluatedAt: new Date() };
    });
  }
  async refresh(actor: Principal, id: string) {
    return inTx(this.db, actor, async (tx, actor) => {
      const segment = await loadSegment(tx, actor, parse(uuid, id), 'marketing.segment.edit');
      const count = (await resolveSegment(tx, actor, segment)).size;
      await evidence(tx, actor, 'MARKETING_SEGMENT', id, 'SEGMENT_REFRESHED', { count, revision: segment.revision }, false);
      return { segmentId: id, count, refreshedAt: new Date(), note: 'Frozen campaign snapshots are never changed by refresh.' };
    });
  }
  async exportSegment(actor: Principal, id: string) {
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'marketing.audience.export');
      const segment = await loadSegment(tx, actor, parse(uuid, id), 'marketing.segment.read');
      const rows = [...(await resolveSegment(tx, actor, segment)).values()];
      await evidence(tx, actor, 'MARKETING_SEGMENT', id, 'AUDIENCE_EXPORTED', { count: rows.length });
      return { filename: `segment-${id}.csv`, contentType: 'text/csv', base64: encodeCsv(['reference', 'destination'], rows.map(r => [r.ref, r.destination])).toString('base64') };
    });
  }

  // ------------------------------------------------------------------ imports
  async createImport(actor: Principal, raw: unknown, key: string | null) {
    const input = parse(z.strictObject({ fileId: uuid, segmentId: uuid, channel: channel.default('EMAIL'), fieldMapping: z.strictObject({ destination: z.string().min(1).max(160), firstName: z.string().max(160).optional(), lastName: z.string().max(160).optional() }),
      duplicatePolicy: z.enum(['SKIP', 'UPDATE_METADATA']).default('SKIP'), consentPolicy: z.enum(['NO_CONSENT_IMPORTED', 'EVIDENCE_REQUIRED']).default('NO_CONSENT_IMPORTED') }), raw);
    if (!key || key.length < 8 || key.length > 128) throw new AppError('VALIDATION_FAILED', 'Idempotency-Key must contain 8 to 128 characters.', 400);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'marketing.audience.import');
      const segment = await loadSegment(tx, actor, input.segmentId, 'marketing.segment.edit');
      if (segment.kind !== 'STATIC' || segment.channel !== input.channel) throw new AppError('VALIDATION_FAILED', 'Imports target a static segment of the same channel.', 400);
      const maxRows = typeof actor.entitlements?.marketingImportRowLimit === 'number' ? actor.entitlements.marketingImportRowLimit : 10000;
      const { bytes, version } = await readCleanFile(tx, actor, input.fileId, 10_000_000);
      const prior = await tx.marketingAudienceImport.findUnique({ where: { workspaceId_fileChecksum_idempotencyKey: { workspaceId: actor.workspaceId, fileChecksum: version.checksum, idempotencyKey: key } } });
      if (prior) return prior;
      let rows: Record<string, string>[];
      try { rows = parseCsv(bytes, maxRows); } catch { throw new AppError('VALIDATION_FAILED', 'File is not a valid CSV within the import quota.', 400, { fields: [{ field: 'fileId', reason: 'INVALID_CSV' }] }); }
      const headers = Object.keys(rows[0] ?? {});
      if (headers.some(h => PROHIBITED_COLUMNS.test(h))) throw new AppError('VALIDATION_FAILED', 'File contains prohibited personal fields.', 400, { fields: [{ field: 'fileId', reason: 'PROHIBITED_FIELDS' }] });
      if (!headers.includes(input.fieldMapping.destination)) throw new AppError('VALIDATION_FAILED', 'Mapped destination column is missing.', 400, { fields: [{ field: 'fieldMapping.destination', reason: 'MISSING_COLUMN' }] });
      const job = await tx.marketingAudienceImport.create({ data: { workspaceId: actor.workspaceId, segmentId: segment.id, fileId: input.fileId, fileChecksum: version.checksum, channel: input.channel, fieldMapping: input.fieldMapping,
        duplicatePolicy: input.duplicatePolicy, consentPolicy: input.consentPolicy, status: 'VALIDATING', createdByUserId: actor.userId, idempotencyKey: key } });
      const seen = new Set<string>(); let rejected = 0;
      for (const [i, row] of rows.entries()) {
        const normalized = normalizeDestination(input.channel, row[input.fieldMapping.destination] ?? '');
        const hash = normalized ? destinationHash(input.channel, normalized) : null, duplicate = Boolean(hash && seen.has(hash));
        if (hash) seen.add(hash); if (!normalized) rejected++;
        await tx.marketingAudienceImportRow.create({ data: { workspaceId: actor.workspaceId, importId: job.id, rowNumber: i + 2, destinationHash: hash, destinationSealed: normalized ? encrypt(JSON.stringify({ destination: normalized, firstName: input.fieldMapping.firstName ? row[input.fieldMapping.firstName] : undefined, lastName: input.fieldMapping.lastName ? row[input.fieldMapping.lastName] : undefined })) : null,
          maskedDestination: normalized ? maskDestination(input.channel, normalized) : null, errorCode: normalized ? null : 'INVALID_DESTINATION', duplicate } });
      }
      const ready = await tx.marketingAudienceImport.update({ where: { id: job.id }, data: { status: 'PREVIEW_READY', rejectedCount: rejected } });
      await evidence(tx, actor, 'MARKETING_IMPORT', job.id, 'AUDIENCE_IMPORT_STARTED', { rows: rows.length, rejected });
      return ready;
    });
  }
  async getImport(actor: Principal, id: string) {
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'marketing.audience.import');
      const job = await tx.marketingAudienceImport.findFirst({ where: { workspaceId: actor.workspaceId, id: parse(uuid, id) } });
      if (!job) throw notFound('Import');
      await loadSegment(tx, actor, job.segmentId, 'marketing.segment.read');
      const preview = await tx.marketingAudienceImportRow.findMany({ where: { importId: id }, orderBy: { rowNumber: 'asc' }, take: 20, select: { rowNumber: true, maskedDestination: true, errorCode: true, duplicate: true } });
      return { ...job, preview, consentNotice: 'Imports never create marketing consent.' };
    });
  }
  /** Commits identities (no CRM Contacts are created). Resumable/idempotent: completed jobs return as-is. */
  async confirmImport(actor: Principal, id: string) {
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'marketing.audience.import');
      const job = await tx.marketingAudienceImport.findFirst({ where: { workspaceId: actor.workspaceId, id: parse(uuid, id) } });
      if (!job) throw notFound('Import');
      if (['COMPLETED', 'PARTIAL'].includes(job.status)) return job;
      if (job.status !== 'PREVIEW_READY') throw new AppError('INVALID_STATE_TRANSITION', 'Import is not ready to confirm.', 409);
      await loadSegment(tx, actor, job.segmentId, 'marketing.segment.edit');
      await tx.marketingAudienceImport.update({ where: { id }, data: { status: 'PROCESSING' } });
      const rows = await tx.marketingAudienceImportRow.findMany({ where: { importId: id, errorCode: null, duplicate: false }, orderBy: { rowNumber: 'asc' } });
      let imported = 0;
      for (const row of rows) {
        const sealed = JSON.parse(decrypt(row.destinationSealed)!) as { destination: string; firstName?: string; lastName?: string };
        const existing = await tx.marketingAudienceIdentity.findUnique({ where: { workspaceId_channel_destinationHash: { workspaceId: actor.workspaceId, channel: job.channel, destinationHash: row.destinationHash! } } });
        const identity = existing ? (job.duplicatePolicy === 'UPDATE_METADATA' ? await tx.marketingAudienceIdentity.update({ where: { id: existing.id }, data: { metadata: { firstName: sealed.firstName, lastName: sealed.lastName } } }) : existing)
          : await tx.marketingAudienceIdentity.create({ data: { workspaceId: actor.workspaceId, channel: job.channel, destinationEncrypted: encrypt(sealed.destination), destinationHash: row.destinationHash!, metadata: { firstName: sealed.firstName, lastName: sealed.lastName }, sourceImportId: id } });
        await tx.marketingSegmentMember.upsert({ where: { segmentId_identityRef: { segmentId: job.segmentId, identityRef: 'AUDIENCE:' + identity.id } }, create: { workspaceId: actor.workspaceId, segmentId: job.segmentId, identityRef: 'AUDIENCE:' + identity.id, source: 'IMPORT:' + id }, update: { removedAt: null } });
        await tx.marketingAudienceImportRow.update({ where: { id: row.id }, data: { identityId: identity.id, destinationSealed: null } });
        if (!existing) imported++;
      }
      await tx.marketingSegment.update({ where: { id: job.segmentId }, data: { revision: { increment: 1 }, version: { increment: 1 } } });
      const done = await tx.marketingAudienceImport.update({ where: { id }, data: { status: job.rejectedCount ? 'PARTIAL' : 'COMPLETED', importedCount: imported } });
      await evidence(tx, actor, 'MARKETING_IMPORT', id, 'AUDIENCE_IMPORT_COMPLETED', { imported, rejected: job.rejectedCount });
      return done;
    });
  }
  async importErrors(actor: Principal, id: string) {
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'marketing.audience.import'); requirePermission(actor, 'marketing.audience.export');
      const job = await tx.marketingAudienceImport.findFirst({ where: { workspaceId: actor.workspaceId, id: parse(uuid, id) } });
      if (!job) throw notFound('Import');
      return tx.marketingAudienceImportRow.findMany({ where: { importId: id, OR: [{ errorCode: { not: null } }, { duplicate: true }] }, orderBy: { rowNumber: 'asc' }, select: { rowNumber: true, maskedDestination: true, errorCode: true, duplicate: true } });
    });
  }
  /** Authorized CRM matching: links (never merges/overwrites) an imported identity to a readable Contact. */
  async linkCrm(actor: Principal, identityId: string, raw: unknown) {
    const input = parse(z.strictObject({ contactId: uuid }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'marketing.audience.import'); requirePermission(actor, 'crm.contact.read');
      const identity = await tx.marketingAudienceIdentity.findFirst({ where: { workspaceId: actor.workspaceId, id: parse(uuid, identityId) } });
      const contact = await tx.crmContact.findFirst({ where: { workspaceId: actor.workspaceId, id: input.contactId, isDeleted: false } });
      if (!identity || !contact) throw notFound('Identity or Contact');
      if (identity.crmContactId && identity.crmContactId !== input.contactId) throw new AppError('INVALID_STATE_TRANSITION', 'Identity is already linked to another Contact.', 409);
      const updated = await tx.marketingAudienceIdentity.update({ where: { id: identity.id }, data: { crmContactId: input.contactId } });
      await evidence(tx, actor, 'MARKETING_AUDIENCE_IDENTITY', identity.id, 'AUDIENCE_IDENTITY_LINKED', { contactId: input.contactId });
      return { id: updated.id, crmContactId: updated.crmContactId, channel: updated.channel };
    });
  }
  static checksum(rows: string[]) { return sha256(rows.sort().join('|')); }
  static channelOf(value: string) { return value as Channel; }
}
