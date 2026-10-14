import { Prisma, type PrismaClient, type SpaImportJob, type SpaExportJob } from '@prisma/client';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { AppError, isAppError } from '../errors';
import { evidence, lock, requirePermission, resolvePrincipal, type Principal, type Tx } from '../process-platform/context';
import { canonical, pageQuery, parse, uuid } from '../process-platform/dto';
import { parseCsv, encodeCsv } from '../process-platform/csv';
import { schemaSnapshot, type SchemaSnapshot } from './field-metadata';
import { SpaItemService } from './item-service';
import { spaReferenceContext } from './reference-adapter';
import { FileArtifactService, type PreparedFileArtifact } from '../collab/files/artifact-service';
import type { FileContentPurpose } from '../collab/files/content-authority';

const filterSchema = z.array(z.strictObject({ fieldCode: z.string().max(64), operator: z.enum(['EQ','NEQ','CONTAINS']), value: z.json() })).max(30);
export const importInput = z.strictObject({ fileId: uuid, fieldMapping: z.record(z.string().min(1).max(160), z.string().min(1).max(64)),
  mode: z.enum(['CREATE_ONLY','UPSERT_BY_EXTERNAL_KEY']), sourceSystem: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).optional(),
  externalKeyColumn: z.string().trim().min(1).max(160).optional() });
export const exportInput = z.strictObject({ filters: filterSchema.default([]), fieldCodes: z.array(z.string().max(64)).min(1).max(100) });
const systemExportFields = new Set(['title','itemNumber','status','createdAt','updatedAt','assignedUserId']);
const exportScope = exportInput.extend({ itemIds: z.array(uuid), artifactItemIds: z.array(uuid).optional() });
const emptyBody = z.strictObject({});

export class SpaTransferService {
  private readonly items: SpaItemService;
  constructor(private readonly db: PrismaClient, private readonly artifacts = new FileArtifactService()) { this.items = new SpaItemService(db); }
  private async schema(tx: Tx, actor: Principal, typeId: string, writable = false) {
    parse(uuid, typeId);
    const type = await tx.spaEntityType.findFirst({ where: { workspaceId: actor.workspaceId, id: typeId, deletedAt: null } });
    if (!type) throw new AppError('SPA_TYPE_NOT_FOUND', 'Type was not found.', 404);
    if (writable && type.status !== 'ACTIVE') throw new AppError('SPA_TYPE_ARCHIVED', 'Active Type is required.', 409);
    const publication = await tx.spaSchemaVersion.findUnique({ where: { workspaceId_typeId_versionNumber: {
      workspaceId: actor.workspaceId, typeId, versionNumber: type.schemaVersion } } });
    if (!publication) throw new AppError('SPA_SCHEMA_NOT_PUBLISHED', 'Published schema is required.', 422);
    return parse(schemaSnapshot, publication.snapshot);
  }
  private async exportFields(tx: Tx, actor: Principal, typeId: string, snapshot: SchemaSnapshot, fields: string[]) {
    if (new Set(fields).size !== fields.length) throw new AppError('SPA_EXPORT_FORBIDDEN_FIELD', 'Export fields must be unique.', 422);
    for (const code of fields) {
      if (systemExportFields.has(code)) continue;
      const field = snapshot.fields.find(f => f.code === code && f.isActive);
      if (!field || !(await this.items.policies.fieldAccess(tx, actor, typeId, field.id)).canView)
        throw new AppError('SPA_EXPORT_FORBIDDEN_FIELD', 'Export field is unavailable.', 403);
    }
  }
  private accessibleJob(actor: Principal, requester: string, permission: string) {
    const scope = requirePermission(actor, permission);
    if (requester !== actor.userId && scope !== 'WORKSPACE') throw new AppError('PERMISSION_DENIED', 'Job permission is required.', 403);
  }
  private async authorizeExport(tx: Tx, actor: Principal, job: SpaExportJob) {
    this.accessibleJob(actor, job.requestedByUserId, 'SPA.ITEM.EXPORT');
    requirePermission(actor, 'SPA.ITEM.READ');
    const scope = parse(exportScope, job.scopeSnapshot);
    const snapshot = await this.schema(tx, actor, job.typeId);
    await this.exportFields(tx, actor, job.typeId, snapshot,
      [...new Set([...scope.fieldCodes, ...scope.filters.map(filter => filter.fieldCode)])]);
    for (const filter of scope.filters) if (!systemExportFields.has(filter.fieldCode) &&
      !snapshot.fields.some(field => field.code === filter.fieldCode && field.isSearchable))
      throw new AppError('SPA_EXPORT_FORBIDDEN_FIELD', 'Filter field is unavailable.', 403);
    // Older artifacts lack the exact output IDs; check their entire original scope.
    const ids = scope.artifactItemIds ?? scope.itemIds;
    const total = await tx.spaItem.count({ where: { workspaceId: actor.workspaceId, typeId: job.typeId,
      id: { in: ids }, status: { not: 'TRASHED' }, AND: [await this.items.policies.itemWhere(tx, actor, job.typeId, 'SPA.ITEM.READ'),
        await this.items.policies.itemWhere(tx, actor, job.typeId, 'SPA.ITEM.EXPORT')] } });
    if (total !== ids.length)
      throw new AppError('PERMISSION_DENIED', 'Export scope is no longer accessible.', 403);
  }
  /** Files calls this at every byte boundary, including copied immutable objects. */
  async authorizeArtifact(tx: Tx, workspaceId: string, userId: string, objectKey: string, purpose: FileContentPurpose) {
    const binding = await tx.fileArtifactBinding.findUnique({ where: { workspaceId_objectKey: { workspaceId, objectKey } } });
    if (!binding) return;
    if (!['DOWNLOAD', 'PROCESS'].includes(purpose))
      throw new AppError('PERMISSION_DENIED', 'Private job artifacts cannot be published or repurposed.', 403);
    const actor = await resolvePrincipal(tx, workspaceId, userId);
    if (binding.entityType === 'SPA_EXPORT_JOB') {
      const job = await tx.spaExportJob.findFirst({ where: { workspaceId, id: binding.entityId } });
      if (!job || job.status !== 'SUCCEEDED' || job.expiresAt <= new Date())
        throw new AppError('FILE_DELIVERY_UNAVAILABLE', 'The export is unavailable or expired.', 410);
      await this.authorizeExport(tx, actor, job);
    } else if (binding.entityType === 'SPA_IMPORT_JOB') {
      const job = await tx.spaImportJob.findFirst({ where: { workspaceId, id: binding.entityId } });
      if (!job || !job.reportFileId || !['SUCCEEDED', 'CANCELLED'].includes(job.status))
        throw new AppError('FILE_DELIVERY_UNAVAILABLE', 'The import report is unavailable.', 410);
      this.accessibleJob(actor, job.createdByUserId, 'SPA.ITEM.IMPORT');
    } else throw new AppError('PERMISSION_DENIED', 'Artifact owner is unavailable.', 403);
  }
  async queueImport(actor: Principal, typeId: string, raw: unknown) {
    requirePermission(actor, 'SPA.ITEM.IMPORT');
    const input = parse(importInput, raw);
    if (input.mode === 'UPSERT_BY_EXTERNAL_KEY' && (!input.sourceSystem || !input.externalKeyColumn))
      throw new AppError('SPA_UPSERT_KEY_REQUIRED', 'Upsert requires source system and external key column.', 422);
    return this.db.$transaction(async tx => {
      await lock(tx, actor.workspaceId, 'spa:type:' + typeId);
      const snapshot = await this.schema(tx, actor, typeId, true);
      const mapping = Object.values(input.fieldMapping);
      if (!mapping.includes('title') || !mapping.includes('assignedUserId') || new Set(mapping).size !== mapping.length)
        throw new AppError('SPA_IMPORT_MAPPING_INVALID', 'Map each field once, including title and responsible User.', 422);
      for (const code of mapping) {
        if (['title','assignedUserId','companyId','contacts'].includes(code)) continue;
        const field = snapshot.fields.find(f => f.code === code && f.isActive);
        if (!field || !(await this.items.policies.fieldAccess(tx, actor, typeId, field.id)).canEdit)
          throw new AppError('SPA_IMPORT_MAPPING_INVALID', 'Mapped field is unavailable.', 422);
      }
      const references = await spaReferenceContext(tx, actor, this.items.policies);
      if (references.checkFile(input.fileId) !== 'OK') throw new AppError('SPA_IMPORT_MAPPING_INVALID', 'Source File is unavailable.', 422);
      const source = await tx.driveFile.findFirstOrThrow({ where: { workspaceId: actor.workspaceId, id: input.fileId } });
      const job = await tx.spaImportJob.create({ data: { workspaceId: actor.workspaceId, typeId, mode: input.mode,
        mapping: input.fieldMapping, sourceFileId: input.fileId, sourceVersionId: source.currentVersionId,
        sourceSystem: input.sourceSystem, externalKeyColumn: input.externalKeyColumn, createdByUserId: actor.userId } });
      await evidence(tx, actor, 'SPA_TYPE', typeId, 'SPA_IMPORT_QUEUED', { jobId: job.id });
      return { jobId: job.id, status: job.status, correlationId: job.correlationId };
    }, { timeout: 30000 });
  }
  async importStatus(actor: Principal, typeId: string, jobId: string) {
    requirePermission(actor, 'SPA.ITEM.IMPORT'); parse(uuid, typeId); parse(uuid, jobId);
    return this.db.$transaction(async tx => {
      const job = await tx.spaImportJob.findFirst({ where: { workspaceId: actor.workspaceId, typeId, id: jobId } });
      if (!job) throw new AppError('SPA_IMPORT_NOT_FOUND', 'Import Job was not found.', 404);
      this.accessibleJob(actor, job.createdByUserId, 'SPA.ITEM.IMPORT');
      const rows = await tx.spaImportRow.findMany({ where: { workspaceId: actor.workspaceId, jobId }, orderBy: { rowNumber: 'asc' }, take: 1000 });
      return { jobId: job.id, status: job.status, totals: job.totals, errorCode: job.errorCode, reportFileId: job.reportFileId,
        cancelRequested: job.cancelRequested, correlationId: job.correlationId,
        rows: rows.map(r => ({ rowNumber: r.rowNumber, status: r.status, errorCodes: r.errorCodes })) };
    });
  }
  async cancelImport(actor: Principal, typeId: string, jobId: string, raw: unknown) {
    requirePermission(actor, 'SPA.ITEM.IMPORT'); parse(uuid, typeId); parse(uuid, jobId); parse(emptyBody, raw);
    return this.db.$transaction(async tx => {
      await lock(tx, actor.workspaceId, 'spa:import:' + jobId);
      const job = await tx.spaImportJob.findFirst({ where: { workspaceId: actor.workspaceId, typeId, id: jobId } });
      if (!job) throw new AppError('SPA_IMPORT_NOT_FOUND', 'Import Job was not found.', 404);
      this.accessibleJob(actor, job.createdByUserId, 'SPA.ITEM.IMPORT');
      if (['SUCCEEDED','FAILED','CANCELLED'].includes(job.status)) return { jobId, status: job.status };
      const result = await tx.spaImportJob.update({ where: { id: jobId }, data: { cancelRequested: true,
        ...(job.status === 'QUEUED' ? { status: 'CANCELLED' } : {}) } });
      await evidence(tx, actor, 'SPA_TYPE', typeId, 'SPA_IMPORT_CANCELLED', { jobId, status: result.status });
      return { jobId, status: result.status, cancelRequested: true };
    });
  }
  async queueExport(actor: Principal, typeId: string, raw: unknown) {
    requirePermission(actor, 'SPA.ITEM.EXPORT'); requirePermission(actor, 'SPA.ITEM.READ');
    const input = parse(exportInput, raw);
    return this.db.$transaction(async tx => {
      const snapshot = await this.schema(tx, actor, typeId);
      await this.exportFields(tx, actor, typeId, snapshot, input.fieldCodes);
      await this.exportFields(tx, actor, typeId, snapshot, [...new Set(input.filters.map(f => f.fieldCode))]);
      const items = await tx.spaItem.findMany({ where: { workspaceId: actor.workspaceId, typeId, status: { not: 'TRASHED' },
        AND: [await this.items.policies.itemWhere(tx, actor, typeId, 'SPA.ITEM.READ'), await this.items.policies.itemWhere(tx, actor, typeId, 'SPA.ITEM.EXPORT')] },
        orderBy: { id: 'asc' }, select: { id: true } });
      const ids = items.map(item => item.id);
      const job = await tx.spaExportJob.create({ data: { workspaceId: actor.workspaceId, typeId,
        requestedByUserId: actor.userId, scopeSnapshot: { ...input, itemIds: ids }, expiresAt: new Date(Date.now() + 3600000) } });
      await evidence(tx, actor, 'SPA_TYPE', typeId, 'SPA_EXPORT_QUEUED', { jobId: job.id });
      return { jobId: job.id, status: job.status, correlationId: job.correlationId };
    }, { timeout: 30000 });
  }
  async exportStatus(actor: Principal, typeId: string, jobId: string) {
    requirePermission(actor, 'SPA.ITEM.EXPORT'); parse(uuid, typeId); parse(uuid, jobId);
    return this.db.$transaction(async tx => {
      const job = await tx.spaExportJob.findFirst({ where: { workspaceId: actor.workspaceId, typeId, id: jobId } });
      if (!job) throw new AppError('SPA_EXPORT_NOT_FOUND', 'Export Job was not found.', 404);
      await this.authorizeExport(tx, actor, job);
      return { jobId, status: job.status, errorCode: job.errorCode, expiresAt: job.expiresAt, correlationId: job.correlationId,
        downloadFileId: job.expiresAt > new Date() && job.status === 'SUCCEEDED' ? job.downloadFileId : null };
    });
  }
  async trash(actor: Principal, typeId: string, raw: unknown) {
    requirePermission(actor, 'SPA.ITEM.RESTORE');
    const query = parse(pageQuery, raw);
    return this.db.$transaction(async tx => {
      await this.schema(tx, actor, typeId);
      const where = { AND: [await this.items.policies.itemWhere(tx, actor, typeId, 'SPA.ITEM.RESTORE')], workspaceId: actor.workspaceId, typeId, status: 'TRASHED' };
      const data = await tx.spaItem.findMany({ where, orderBy: [{ trashedAt: 'desc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit, take: query.limit,
        select: { id: true, title: true, itemNumber: true, status: true, version: true, trashedAt: true, purgeAfter: true } });
      const total = await tx.spaItem.count({ where });
      return { data, meta: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) } };
    });
  }
  async queuePurge(actor: Principal, typeId: string, itemId: string, raw: unknown) {
    requirePermission(actor, 'SPA.ITEM.HARD_DELETE'); parse(emptyBody, raw);
    return this.db.$transaction(async tx => {
      await lock(tx, actor.workspaceId, 'spa:type:' + typeId);
      const item = await this.items.load(tx, actor, typeId, itemId, 'SPA.ITEM.HARD_DELETE');
      if (item.legalHold) throw new AppError('SPA_RETENTION_HOLD', 'Item is subject to a retention hold.', 409);
      if (item.status !== 'TRASHED' || !item.purgeAfter || item.purgeAfter > new Date())
        throw new AppError('SPA_PURGE_BLOCKED', 'Item retention has not elapsed.', 409);
      const existing = await tx.spaPurgeJob.findFirst({ where: { workspaceId: actor.workspaceId, typeId, itemId, status: { in: ['QUEUED','RUNNING','SUCCEEDED'] } } });
      const job = existing ?? await tx.spaPurgeJob.create({ data: { workspaceId: actor.workspaceId, typeId, itemId,
        requestedByUserId: actor.userId, legalHoldCheckedAt: new Date() } });
      if (!existing) await evidence(tx, actor, 'SPA_ITEM', itemId, 'SPA_PURGE_QUEUED', { jobId: job.id });
      return { jobId: job.id, status: job.status, correlationId: job.correlationId };
    });
  }
  private async claim(kind: 'import' | 'export' | 'purge', limit: number, token: string) {
    const table = Prisma.raw({ import: 'spa_import_jobs', export: 'spa_export_jobs', purge: 'spa_purge_jobs' }[kind]);
    const due = kind === 'purge' ? Prisma.sql`status='QUEUED' OR (status='RUNNING' AND lease_expires_at < now())`
      : Prisma.sql`(status='QUEUED' AND next_attempt_at <= now()) OR (status='RUNNING' AND lease_expires_at < now())`;
    return this.db.$transaction(tx => tx.$queryRaw<Array<{ id: string; workspace_id: string; type_id: string }>>(Prisma.sql`
      WITH due AS (SELECT id FROM ${table} WHERE ${due} ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT ${limit})
      UPDATE ${table} j SET status='RUNNING', claim_token=${token}::uuid, lease_expires_at=now()+interval '10 minutes'
      FROM due WHERE j.id=due.id RETURNING j.id,j.workspace_id,j.type_id`));
  }
  private importPayload(snapshot: SchemaSnapshot, mapping: Record<string, string>, row: Record<string, string>) {
    const payload: Record<string, unknown> = { fieldValues: {} };
    const fields = payload.fieldValues as Record<string, unknown>;
    for (const [column, target] of Object.entries(mapping)) {
      if (!(column in row)) throw new AppError('SPA_IMPORT_MAPPING_INVALID', 'Mapped source column is missing.', 422);
      const value = row[column];
      if (['title','assignedUserId','companyId'].includes(target)) { if (value !== '') payload[target] = value; continue; }
      if (target === 'contacts') { try { payload.contacts = value ? JSON.parse(value) : []; } catch { throw new AppError('SPA_IMPORT_ROW_INVALID', 'Contacts column must contain JSON.', 422); } continue; }
      const field = snapshot.fields.find(f => f.code === target && f.isActive);
      if (!field) throw new AppError('SPA_IMPORT_MAPPING_INVALID', 'Mapped field is unavailable.', 422);
      if (!value) { fields[target] = null; continue; }
      if (field.fieldType === 'INTEGER' && !field.isMultiple) {
        if (!/^[+-]?\d+$/.test(value)) throw new AppError('SPA_IMPORT_ROW_INVALID', 'Integer input is invalid.', 422);
        fields[target] = Number(value);
      } else if (field.fieldType === 'BOOLEAN' && !field.isMultiple) {
        if (!['true','false'].includes(value.toLowerCase())) throw new AppError('SPA_IMPORT_ROW_INVALID', 'Boolean input is invalid.', 422);
        fields[target] = value.toLowerCase() === 'true';
      } else if (field.isMultiple || ['MULTI_LIST','CRM_REF','MONEY'].includes(field.fieldType)) {
        try { fields[target] = JSON.parse(value); } catch { throw new AppError('SPA_IMPORT_ROW_INVALID', 'Structured field input must contain JSON.', 422); }
      } else fields[target] = value;
    }
    return payload;
  }
  private async importRow(job: SpaImportJob, token: string, row: Record<string, string>, rowNumber: number) {
    return this.db.$transaction(async tx => {
      await lock(tx, job.workspaceId, 'spa:import:' + job.id);
      const currentJob = await tx.spaImportJob.findFirst({ where: { workspaceId: job.workspaceId, id: job.id,
        status: 'RUNNING', claimToken: token, leaseExpiresAt: { gt: new Date() } } });
      if (!currentJob || currentJob.cancelRequested) return 'STOP' as const;
      if (await tx.spaImportRow.findUnique({ where: { workspaceId_jobId_rowNumber: { workspaceId: job.workspaceId, jobId: job.id, rowNumber } } })) return 'REPLAY' as const;
      await lock(tx, job.workspaceId, 'spa:type:' + job.typeId);
      const actor = await resolvePrincipal(tx, job.workspaceId, job.createdByUserId); requirePermission(actor, 'SPA.ITEM.IMPORT');
      const snapshot = await this.schema(tx, actor, job.typeId, true);
      const mapping = parse(importInput.shape.fieldMapping, job.mapping);
      const payload = this.importPayload(snapshot, mapping, row);
      const externalId = job.externalKeyColumn ? row[job.externalKeyColumn]?.trim() : undefined;
      if (job.mode === 'UPSERT_BY_EXTERNAL_KEY' && (!externalId || externalId.length > 160 || !job.sourceSystem))
        throw new AppError('SPA_UPSERT_KEY_REQUIRED', 'Row requires a stable external key.', 422);
      const key = externalId && job.sourceSystem ? { workspaceId: job.workspaceId, typeId: job.typeId, sourceSystem: job.sourceSystem, externalId } : null;
      const existingKey = key ? await tx.spaItemExternalKey.findUnique({ where: { workspaceId_typeId_sourceSystem_externalId: key } }) : null;
      let itemId: string;
      if (existingKey) {
        if (job.mode === 'CREATE_ONLY') throw new AppError('SPA_GENERATION_CONFLICT', 'External key already exists.', 409);
        if (!existingKey.itemId) throw new AppError('SPA_GENERATION_CONFLICT', 'External key identifies a purged Item and cannot be replayed as a new record.', 409);
        const item = await this.items.load(tx, actor, job.typeId, existingKey.itemId, 'SPA.ITEM.UPDATE');
        const result = await this.items.updateInTransaction(tx, actor, job.typeId, item.id, { ...payload, expectedVersion: item.version });
        itemId = result.id;
      } else {
        const result = await this.items.createInTransaction(tx, actor, job.typeId, payload, `spa.import:${job.id}:${rowNumber}`);
        itemId = result.id;
        if (key) await tx.spaItemExternalKey.create({ data: { ...key, itemId } });
      }
      await tx.spaImportRow.create({ data: { workspaceId: job.workspaceId, jobId: job.id, rowNumber, status: 'SUCCEEDED',
        externalSource: job.sourceSystem, externalId, itemId } });
      await tx.spaImportJob.update({ where: { id: job.id }, data: { leaseExpiresAt: new Date(Date.now() + 600000) } });
      return 'SUCCEEDED' as const;
    }, { timeout: 30000 });
  }
  private async runImport(job: SpaImportJob, token: string) {
    const source = await this.db.$transaction(async tx => {
      const actor = await resolvePrincipal(tx, job.workspaceId, job.createdByUserId); requirePermission(actor, 'SPA.ITEM.IMPORT');
      const references = await spaReferenceContext(tx, actor, this.items.policies);
      return references.readFile(job.sourceFileId, 10_000_000);
    }, { timeout: 30000 });
    if (source.versionId !== job.sourceVersionId) throw new AppError('SPA_IMPORT_MAPPING_INVALID', 'Source File changed after the import was queued.', 422);
    const rows = parseCsv(source.content);
    for (const [index, row] of rows.entries()) {
      try { if (await this.importRow(job, token, row, index + 2) === 'STOP') break; }
      catch (error) {
        if (!isAppError(error)) throw error;
        if (['PERMISSION_DENIED','UNAUTHENTICATED'].includes(error.code)) throw error;
        const recorded = await this.db.$transaction(async tx => {
          await lock(tx, job.workspaceId, 'spa:import:' + job.id);
          const current = await tx.spaImportJob.findFirst({ where: { id: job.id, workspaceId: job.workspaceId,
            status: 'RUNNING', claimToken: token, leaseExpiresAt: { gt: new Date() }, cancelRequested: false } });
          if (!current) return false;
          await tx.spaImportRow.upsert({ where: { workspaceId_jobId_rowNumber: { workspaceId: job.workspaceId, jobId: job.id, rowNumber: index + 2 } },
            create: { workspaceId: job.workspaceId, jobId: job.id, rowNumber: index + 2, status: 'FAILED', errorCodes: [error.code] }, update: {} });
          await tx.spaImportJob.update({ where: { id: job.id }, data: { leaseExpiresAt: new Date(Date.now() + 600000) } });
          return true;
        });
        if (!recorded) break;
      }
    }
    const outcomes = await this.db.spaImportRow.findMany({ where: { workspaceId: job.workspaceId, jobId: job.id }, orderBy: { rowNumber: 'asc' } });
    const prepared = await this.artifacts.prepare(job.workspaceId, encodeCsv(['rowNumber', 'status', 'itemId', 'errorCodes'],
      outcomes.map(row => [row.rowNumber, row.status, row.itemId ?? '',
        Array.isArray(row.errorCodes) ? row.errorCodes.filter(code => typeof code === 'string').join(';') : ''])), 'text/csv');
    let published = false;
    try { return await this.db.$transaction(async tx => {
      await lock(tx, job.workspaceId, 'spa:import:' + job.id);
      const current = await tx.spaImportJob.findFirst({ where: { id: job.id, workspaceId: job.workspaceId, status: 'RUNNING', claimToken: token,
        leaseExpiresAt: { gt: new Date() } } });
      if (!current) return;
      const outcomes = await tx.spaImportRow.findMany({ where: { workspaceId: job.workspaceId, jobId: job.id } });
      const succeeded = outcomes.filter(r => r.status === 'SUCCEEDED').length, failed = outcomes.filter(r => r.status === 'FAILED').length;
      const status = current.cancelRequested ? 'CANCELLED' : 'SUCCEEDED';
      const actor = await resolvePrincipal(tx, job.workspaceId, job.createdByUserId);
      requirePermission(actor, 'SPA.ITEM.IMPORT');
      await this.schema(tx, actor, job.typeId);
      const reportFileId = await this.artifacts.publish(tx, actor, prepared, 'SPA import report ' + job.id + '.csv',
        { entityType: 'SPA_IMPORT_JOB', entityId: job.id });
      await tx.spaImportJob.update({ where: { id: job.id }, data: { status, totals: { total: rows.length, processed: outcomes.length, succeeded, failed },
        reportFileId, errorCode: null, claimToken: null, leaseExpiresAt: null } });
      await evidence(tx, actor, 'SPA_TYPE', job.typeId, status === 'CANCELLED' ? 'SPA_IMPORT_CANCELLED' : 'SPA_IMPORT_COMPLETED',
        { jobId: job.id, reportFileId, processed: outcomes.length, succeeded, failed });
      return true;
    }, { timeout: 30000 }).then(committed => { published = committed === true; return published; });
    } finally { if (!published) await this.artifacts.discard(prepared); }
  }
  private async runExport(job: SpaExportJob, token: string) {
    const scope = parse(exportScope, job.scopeSnapshot);
    const capture = await this.db.$transaction(async tx => {
      await lock(tx, job.workspaceId, 'spa:type:' + job.typeId);
      const actor = await resolvePrincipal(tx, job.workspaceId, job.requestedByUserId);
      requirePermission(actor, 'SPA.ITEM.EXPORT'); requirePermission(actor, 'SPA.ITEM.READ');
      const snapshot = await this.schema(tx, actor, job.typeId);
      await this.exportFields(tx, actor, job.typeId, snapshot, scope.fieldCodes);
      await this.exportFields(tx, actor, job.typeId, snapshot, [...new Set(scope.filters.map(f => f.fieldCode))]);
      for (const filter of scope.filters) if (!systemExportFields.has(filter.fieldCode) &&
        !snapshot.fields.some(f => f.code === filter.fieldCode && f.isSearchable))
        throw new AppError('SPA_EXPORT_FORBIDDEN_FIELD', 'Filter field is unavailable.', 403);
      const rows: unknown[][] = [], records: Array<{ id: string; version: number }> = [];
      let bytes = 0;
      for (const itemId of scope.itemIds) {
        const item = await tx.spaItem.findFirst({ where: { workspaceId: job.workspaceId, typeId: job.typeId, id: itemId, status: { not: 'TRASHED' } } });
        if (!item || !await this.items.policies.allowed(tx, actor, item, 'SPA.ITEM.READ') || !await this.items.policies.allowed(tx, actor, item, 'SPA.ITEM.EXPORT')) continue;
        const projection = await this.items.readInTransaction(tx, actor, job.typeId, itemId);
        const projected = projection as unknown as Record<string, unknown>;
        const valueOf = (code: string): unknown => systemExportFields.has(code) ? projected[code] : projection.fieldValues[code] ?? null;
        if (!scope.filters.every(f => {
          const value = valueOf(f.fieldCode);
          const same = canonical(value) === canonical(f.value);
          return f.operator === 'EQ' ? same : f.operator === 'NEQ' ? !same
            : typeof value === 'string' && typeof f.value === 'string' && value.toLowerCase().includes(f.value.toLowerCase());
        })) continue;
        const row = scope.fieldCodes.map(valueOf);
        bytes += Buffer.byteLength(JSON.stringify(row));
        if (rows.length >= 10000 || bytes > 40_000_000) throw new AppError('FILE_TOO_LARGE', 'Export exceeds synchronous artifact limits.', 413);
        rows.push(row); records.push({ id: item.id, version: item.version });
      }
      return { rows, records };
    }, { timeout: 120000 });
    const prepared = await this.artifacts.prepare(job.workspaceId, encodeCsv(scope.fieldCodes, capture.rows), 'text/csv');
    let published = false;
    try {
      return await this.db.$transaction(async tx => {
        await lock(tx, job.workspaceId, 'spa:type:' + job.typeId);
        const currentJob = await tx.spaExportJob.findFirst({ where: { workspaceId: job.workspaceId, id: job.id,
          status: 'RUNNING', claimToken: token, leaseExpiresAt: { gt: new Date() }, expiresAt: { gt: new Date() } } });
        if (!currentJob) return false;
        const actor = await resolvePrincipal(tx, job.workspaceId, job.requestedByUserId);
        requirePermission(actor, 'SPA.ITEM.EXPORT'); requirePermission(actor, 'SPA.ITEM.READ');
        const snapshot = await this.schema(tx, actor, job.typeId);
        await this.exportFields(tx, actor, job.typeId, snapshot, scope.fieldCodes);
        for (const record of capture.records) {
          const item = await tx.spaItem.findFirst({ where: { workspaceId: job.workspaceId, typeId: job.typeId, id: record.id, status: { not: 'TRASHED' } } });
          if (!item || item.version !== record.version || !await this.items.policies.allowed(tx, actor, item, 'SPA.ITEM.READ') ||
            !await this.items.policies.allowed(tx, actor, item, 'SPA.ITEM.EXPORT'))
            throw new AppError('RESOURCE_VERSION_CONFLICT', 'Export scope changed during artifact processing.', 409);
        }
        const fileId = await this.artifacts.publish(tx, actor, prepared, 'SPA export ' + job.id + '.csv',
          { entityType: 'SPA_EXPORT_JOB', entityId: job.id });
        await tx.spaExportJob.update({ where: { id: job.id }, data: { status: 'SUCCEEDED', downloadFileId: fileId,
          scopeSnapshot: { ...scope, artifactItemIds: capture.records.map(record => record.id) },
          claimToken: null, leaseExpiresAt: null, errorCode: null } });
        await evidence(tx, actor, 'SPA_TYPE', job.typeId, 'SPA_EXPORT_COMPLETED', { jobId: job.id, downloadFileId: fileId, rowCount: capture.rows.length });
        return true;
      }, { timeout: 120000 }).then(result => { published = result; return result; });
    } finally { if (!published) await this.artifacts.discard(prepared); }
  }
  async runTransfers(limit = 5) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid transfer limit');
    const token = randomUUID();
    const imports = await this.claim('import', limit, token), exports = await this.claim('export', limit, token);
    let completed = 0, failed = 0, skipped = 0;
    for (const [kind, claimed] of [...imports.map(j => ['import', j] as const), ...exports.map(j => ['export', j] as const)]) {
      const job = kind === 'import' ? await this.db.spaImportJob.findFirst({ where: { id: claimed.id, workspaceId: claimed.workspace_id, claimToken: token } })
        : await this.db.spaExportJob.findFirst({ where: { id: claimed.id, workspaceId: claimed.workspace_id, claimToken: token } });
      if (!job) { skipped++; continue; }
      try {
        const finished = kind === 'import' ? await this.runImport(job as SpaImportJob, token) : await this.runExport(job as SpaExportJob, token);
        if (!finished) { skipped++; continue; }
        completed++;
      } catch (error) {
        const attempts = job.attempts + 1;
        const code = isAppError(error) ? error.code : kind === 'import' ? 'SPA_IMPORT_ROW_INVALID' : 'SPA_EXPORT_FAILED';
        const terminal = attempts >= 5 || ['PERMISSION_DENIED','SPA_IMPORT_MAPPING_INVALID','SPA_IMPORT_ROW_INVALID','SPA_EXPORT_FORBIDDEN_FIELD'].includes(code);
        const data = { status: terminal ? 'FAILED' : 'QUEUED', errorCode: code, attempts,
          nextAttemptAt: new Date(Date.now() + Math.min(3600000, 30000 * 2 ** attempts)), claimToken: null, leaseExpiresAt: null };
        if (kind === 'import') await this.db.spaImportJob.updateMany({ where: { id: job.id, workspaceId: job.workspaceId, status: 'RUNNING', claimToken: token }, data });
        else await this.db.spaExportJob.updateMany({ where: { id: job.id, workspaceId: job.workspaceId, status: 'RUNNING', claimToken: token }, data });
        failed++;
      }
    }
    return { claimed: imports.length + exports.length, completed, failed, skipped };
  }
  async runPurges(limit = 10) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid purge limit');
    const token = randomUUID(), jobs = await this.claim('purge', limit, token);
    let purged = 0, failed = 0, skipped = 0;
    for (const claimed of jobs) {
      try {
        const done = await this.db.$transaction(async tx => {
          await lock(tx, claimed.workspace_id, 'spa:type:' + claimed.type_id);
          const job = await tx.spaPurgeJob.findFirst({ where: { id: claimed.id, workspaceId: claimed.workspace_id,
            status: 'RUNNING', claimToken: token, leaseExpiresAt: { gt: new Date() } } });
          if (!job) return false;
          const actor = await resolvePrincipal(tx, job.workspaceId, job.requestedByUserId);
          requirePermission(actor, 'SPA.ITEM.HARD_DELETE');
          const item = await this.items.load(tx, actor, job.typeId, job.itemId, 'SPA.ITEM.HARD_DELETE');
          if (item.legalHold) throw new AppError('SPA_RETENTION_HOLD', 'Item is subject to a retention hold.', 409);
          if (item.status !== 'TRASHED' || !item.purgeAfter || item.purgeAfter > new Date())
            throw new AppError('SPA_PURGE_BLOCKED', 'Item retention has not elapsed.', 409);
          const dependencies = await Promise.all([
            tx.spaRecurrenceInstance.count({ where: { workspaceId: job.workspaceId, itemId: item.id } }),
            tx.spaSchemaMigrationValue.count({ where: { workspaceId: job.workspaceId, itemId: item.id } }),
            tx.spaItemRelation.count({ where: { workspaceId: job.workspaceId, targetType: 'SPA_ITEM', targetId: item.id } }),
          ]);
          if (dependencies.some(Boolean)) throw new AppError('SPA_PURGE_BLOCKED', 'Retained domain references prevent physical purge.', 409);
          await tx.spaItemExternalKey.updateMany({ where: { workspaceId: job.workspaceId, typeId: job.typeId, itemId: item.id },
            data: { itemId: null, tombstonedAt: new Date() } });
          await tx.spaItem.delete({ where: { id: item.id } });
          await tx.spaPurgeJob.update({ where: { id: job.id }, data: { status: 'SUCCEEDED', legalHoldCheckedAt: new Date(),
            attemptCount: { increment: 1 }, claimToken: null, leaseExpiresAt: null, errorCode: null } });
          await evidence(tx, actor, 'SPA_ITEM', item.id, 'SPA_ITEM_PURGED', { jobId: job.id, typeId: job.typeId,
            linkedSharedRecordsRetained: true });
          return true;
        }, { timeout: 30000 });
        if (done) purged++; else skipped++;
      } catch (error) {
        await this.db.spaPurgeJob.updateMany({ where: { id: claimed.id, workspaceId: claimed.workspace_id, status: 'RUNNING', claimToken: token },
          data: { status: 'FAILED', attemptCount: { increment: 1 }, errorCode: isAppError(error) ? error.code : 'SPA_PURGE_BLOCKED',
            claimToken: null, leaseExpiresAt: null } });
        failed++;
      }
    }
    return { claimed: jobs.length, purged, failed, skipped };
  }
}

