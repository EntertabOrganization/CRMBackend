import { Prisma, type PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors';
import { evidence, lock, requirePermission, resolvePrincipal, type Principal } from '../process-platform/context';
import { canonical, parse, uuid } from '../process-platform/dto';
import { fieldTypes, parseFieldValue, schemaSnapshot, validateDefinition } from './field-metadata';
import { SpaPolicyService } from './policy-service';
import { spaReferenceContext } from './reference-adapter';
import { storedValue } from './item-service';

export const migrationMapping = z.union([z.literal('STRICT'), z.strictObject({ kind: z.literal('VALUE_MAP'),
  mappings: z.array(z.strictObject({ from: z.json(), to: z.json() })).min(1).max(10000) })]);
export const valueHash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

export class SpaMigrationService {
  constructor(private readonly db: PrismaClient) {}
  async queue(actor: Principal, typeId: string, raw: unknown) {
    requirePermission(actor, 'SPA.SCHEMA.MANAGE', true);
    parse(uuid, typeId);
    const input = parse(z.strictObject({ fieldId: uuid, targetType: z.enum(fieldTypes), mappingStrategy: migrationMapping }), raw);
    if (input.mappingStrategy !== 'STRICT' && new Set(input.mappingStrategy.mappings.map(m => canonical(m.from))).size !== input.mappingStrategy.mappings.length)
      throw new AppError('SPA_FIELD_TYPE_INVALID', 'Conversion mappings must have unique source values.', 422);
    return this.db.$transaction(async tx => {
      await lock(tx, actor.workspaceId, 'spa:type:' + typeId);
      const type = await tx.spaEntityType.findFirst({ where: { workspaceId: actor.workspaceId, id: typeId, deletedAt: null } });
      if (!type) throw new AppError('SPA_TYPE_NOT_FOUND', 'Type was not found.', 404);
      if (type.status === 'ARCHIVED') throw new AppError('SPA_TYPE_ARCHIVED', 'Archived Type is read-only.', 409);
      const published = await tx.spaFieldDefinition.findFirst({ where: { workspaceId: actor.workspaceId, typeId, id: input.fieldId } });
      if (!published) throw new AppError('SPA_FIELD_NOT_FOUND', 'Published Field was not found.', 404);
      const draft = await tx.spaSchemaDraft.findUniqueOrThrow({ where: { workspaceId_typeId: { workspaceId: actor.workspaceId, typeId } } });
      const snapshot = parse(schemaSnapshot, draft.snapshot);
      const field = snapshot.fields.find(f => f.id === input.fieldId);
      if (!field) throw new AppError('SPA_FIELD_NOT_FOUND', 'Draft Field was not found.', 404);
      field.fieldType = input.targetType; field.version += 1;
      validateDefinition(field, actor.workspaceId);
      const updated = await tx.spaSchemaDraft.update({ where: { id: draft.id }, data: { version: { increment: 1 }, snapshot: snapshot as Prisma.InputJsonObject } });
      const job = await tx.spaSchemaMigrationJob.create({ data: { workspaceId: actor.workspaceId, typeId, fieldId: input.fieldId,
        oldVersion: type.schemaVersion, draftId: draft.id, draftVersion: updated.version, targetType: input.targetType,
        fieldMapping: input.mappingStrategy as Prisma.InputJsonValue, createdByUserId: actor.userId } });
      await evidence(tx, actor, 'SPA_TYPE', typeId, 'SPA_SCHEMA_DRAFT_UPDATED', { migrationJobId: job.id, draftVersion: updated.version });
      return { jobId: job.id, status: job.status, correlationId: job.correlationId, draftVersion: updated.version };
    });
  }
  async runDue(limit = 10) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid worker limit');
    const claimToken = randomUUID();
    const jobs = await this.db.$transaction(tx => tx.$queryRaw<Array<{ id: string; workspace_id: string; type_id: string }>>`
      WITH due AS (SELECT id FROM spa_schema_migration_jobs
        WHERE status='QUEUED' OR (status='RUNNING' AND lease_expires_at < now())
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT ${limit})
      UPDATE spa_schema_migration_jobs j SET status='RUNNING', claim_token=${claimToken}::uuid,
        lease_expires_at=now()+interval '5 minutes' FROM due WHERE j.id=due.id
      RETURNING j.id,j.workspace_id,j.type_id`);
    let succeeded = 0, failed = 0;
    for (const claimed of jobs) {
      try {
        const completed = await this.db.$transaction(async tx => {
          await lock(tx, claimed.workspace_id, 'spa:type:' + claimed.type_id);
          const job = await tx.spaSchemaMigrationJob.findFirst({ where: { id: claimed.id, workspaceId: claimed.workspace_id,
            status: 'RUNNING', claimToken, leaseExpiresAt: { gt: new Date() } } });
          if (!job) return false;
          const actor = await resolvePrincipal(tx, job.workspaceId, job.createdByUserId);
          requirePermission(actor, 'SPA.SCHEMA.MANAGE', true);
          const type = await tx.spaEntityType.findFirst({ where: { workspaceId: job.workspaceId, id: job.typeId, deletedAt: null } });
          const draft = await tx.spaSchemaDraft.findFirst({ where: { workspaceId: job.workspaceId, typeId: job.typeId, id: job.draftId } });
          if (!type || type.status === 'ARCHIVED' || !draft || draft.version !== job.draftVersion || type.schemaVersion !== job.oldVersion)
            throw new AppError('SPA_SCHEMA_CONFLICT', 'Schema changed after migration was queued.', 409);
          const snapshot = parse(schemaSnapshot, draft.snapshot);
          const field = snapshot.fields.find(f => f.id === job.fieldId)!;
          const sourcePublication = await tx.spaSchemaVersion.findUniqueOrThrow({ where: { workspaceId_typeId_versionNumber: {
            workspaceId: job.workspaceId, typeId: job.typeId, versionNumber: job.oldVersion } } });
          const oldField = parse(schemaSnapshot, sourcePublication.snapshot).fields.find(f => f.id === job.fieldId)!;
          const mapping = parse(migrationMapping, job.fieldMapping);
          const rows = await tx.spaItemValue.findMany({ where: { workspaceId: job.workspaceId, fieldId: job.fieldId }, orderBy: { itemId: 'asc' } });
          const rawValues = rows.map(row => storedValue(row, oldField));
          const mapped = rawValues.map(value => {
            if (mapping === 'STRICT') return value;
            const entry = mapping.mappings.find(m => canonical(m.from) === canonical(value));
            return entry ? entry.to : value;
          });
          const referenceIds = mapped.flatMap(value => Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === 'string' && uuid.safeParse(v).success);
          const references = await spaReferenceContext(tx, actor, new SpaPolicyService(this.db), referenceIds,
            new Map(referenceIds.map(id => [id, field.referenceTypeId ?? ''])));
          const failures: Array<{ itemId: string; code: string }> = [];
          await tx.spaSchemaMigrationValue.deleteMany({ where: { workspaceId: job.workspaceId, jobId: job.id } });
          for (const [index, row] of rows.entries()) {
            const item = await tx.spaItem.findFirstOrThrow({ where: { workspaceId: job.workspaceId, typeId: job.typeId, id: row.itemId } });
            try {
              const converted = parseFieldValue(field, mapped[index], actor.workspaceId, references);
              await tx.spaSchemaMigrationValue.create({ data: { workspaceId: job.workspaceId, jobId: job.id, itemId: item.id,
                sourceHash: valueHash(rawValues[index]), sourceItemVersion: item.version,
                originalValue: rawValues[index] === null ? Prisma.JsonNull : rawValues[index] as Prisma.InputJsonValue,
                convertedValue: converted === null ? Prisma.JsonNull : converted as Prisma.InputJsonValue } });
            } catch (error) {
              if (!(error instanceof AppError)) throw error;
              failures.push({ itemId: row.itemId, code: 'SPA_SCHEMA_MIGRATION_FAILED' });
            }
          }
          const success = failures.length === 0;
          await tx.spaSchemaMigrationJob.update({ where: { id: job.id }, data: { status: success ? 'SUCCEEDED' : 'FAILED',
            processedCount: rows.length, conversionFailures: failures, completedAt: new Date(), claimToken: null, leaseExpiresAt: null } });
          if (success) await evidence(tx, actor, 'SPA_TYPE', job.typeId, 'SPA_FIELD_MIGRATION_PREVIEWED', { jobId: job.id,
            processedCount: rows.length, convertedValuesStaged: true });
          return success;
        }, { timeout: 120000 });
        if (completed) succeeded++; else failed++;
      } catch {
        await this.db.spaSchemaMigrationJob.updateMany({ where: { id: claimed.id, status: 'RUNNING', claimToken },
          data: { status: 'FAILED', conversionFailures: [{ code: 'SPA_SCHEMA_MIGRATION_FAILED' }], completedAt: new Date(),
            claimToken: null, leaseExpiresAt: null } });
        failed++;
      }
    }
    return { claimed: jobs.length, succeeded, failed };
  }
}
