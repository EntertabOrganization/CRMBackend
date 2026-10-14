import { Prisma, type PrismaClient, type SpaRecurrenceRule } from '@prisma/client';
import { z } from 'zod';
import { AppError, isAppError } from '../errors';
import { assertVersion, evidence, lock, requirePermission, resolvePrincipal, type Principal, type Tx } from '../process-platform/context';
import { pageQuery, parse, timezone, uuid, version } from '../process-platform/dto';
import { expandRecurrence, validateRecurrence, wallClockOf, type RecurrenceDefinition } from '../collab/calendar/recurrence-engine';
import { spaCreateItemDto, SpaItemService } from './item-service';
import { SpaPolicyService } from './policy-service';
import { schemaSnapshot } from './field-metadata';

export const ruleSettings = z.strictObject({ timezone, frequency: z.enum(['DAILY','WEEKLY','MONTHLY','YEARLY','CUSTOM']),
  interval: z.number().int().min(1).max(1000), startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }).optional(), byDay: z.array(z.enum(['MO','TU','WE','TH','FR','SA','SU'])).max(7).optional(),
  maxInstances: z.number().int().min(1).max(100000).optional(), customRule: z.string().max(2000).optional() });
export const createRule = ruleSettings.extend({ templatePayload: spaCreateItemDto });
type Settings = z.infer<typeof ruleSettings>;
function definition(settings: Settings): RecurrenceDefinition {
  if (settings.endsAt && new Date(settings.endsAt) < new Date(settings.startsAt) ||
    settings.frequency === 'CUSTOM' && !settings.customRule || settings.frequency !== 'CUSTOM' && settings.customRule)
    throw new AppError('SPA_RECURRENCE_INVALID', 'Recurrence bounds or custom rule are invalid.', 422);
  let text = settings.frequency === 'CUSTOM' ? settings.customRule! : `FREQ=${settings.frequency};INTERVAL=${settings.interval}`;
  if (settings.byDay?.length && settings.frequency !== 'CUSTOM') text += ';BYDAY=' + settings.byDay.join(',');
  if (settings.maxInstances && settings.frequency !== 'CUSTOM') text += ';COUNT=' + settings.maxInstances;
  if (settings.endsAt && settings.frequency !== 'CUSTOM') text += ';UNTIL=' + new Date(settings.endsAt).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  try { return validateRecurrence({ rruleText: text, sourceTimezone: settings.timezone,
    dtstartLocal: wallClockOf(new Date(settings.startsAt), settings.timezone), isAllDay: false }); }
  catch { throw new AppError('SPA_RECURRENCE_INVALID', 'Recurrence rule is invalid.', 422); }
}
function fromRow(row: SpaRecurrenceRule): Settings {
  return { frequency: row.frequency as Settings['frequency'], timezone: row.timezone, interval: row.interval,
    startsAt: row.startsAt.toISOString(), ...(row.endsAt ? { endsAt: row.endsAt.toISOString() } : {}),
    byDay: row.byDay as Settings['byDay'], maxInstances: row.maxInstances ?? undefined, customRule: row.customRule ?? undefined };
}
function next(settings: Settings, after?: Date) {
  const occurrence = expandRecurrence(definition(settings), { limit: 1,
    ...(after ? { after: wallClockOf(after, settings.timezone) } : {}) })[0]?.startAt ?? null;
  return occurrence && settings.endsAt && occurrence > new Date(settings.endsAt) ? null : occurrence;
}

export class SpaRecurrenceService {
  private readonly items: SpaItemService;
  private readonly policies: SpaPolicyService;
  constructor(private readonly db: PrismaClient) { this.items = new SpaItemService(db); this.policies = new SpaPolicyService(db); }
  private async enabled(tx: Tx, actor: Principal, typeId: string, writable = false) {
    parse(uuid, typeId);
    const type = await tx.spaEntityType.findFirst({ where: { workspaceId: actor.workspaceId, id: typeId, deletedAt: null } });
    if (!type) throw new AppError('SPA_TYPE_NOT_FOUND', 'Type was not found.', 404);
    if (writable && type.status !== 'ACTIVE') throw new AppError('SPA_TYPE_ARCHIVED', 'Active Type is required.', 409);
    if (writable && !await tx.spaCapability.findFirst({ where: { workspaceId: actor.workspaceId, typeId, key: 'RECURRENCE', enabled: true } }))
      throw new AppError('SPA_RECURRENCE_DISABLED', 'Recurrence is disabled.', 409);
  }
  private async row(tx: Tx, actor: Principal, typeId: string, ruleId: string) {
    parse(uuid, ruleId);
    const row = await tx.spaRecurrenceRule.findFirst({ where: { workspaceId: actor.workspaceId, typeId, id: ruleId } });
    if (!row) throw new AppError('SPA_RECURRENCE_NOT_FOUND', 'Recurrence was not found.', 404);
    return row;
  }
  async create(actor: Principal, typeId: string, raw: unknown) {
    requirePermission(actor, 'SPA.RECURRENCE.MANAGE', true);
    const input = parse(createRule, raw);
    definition(input);
    return this.db.$transaction(async tx => {
      await lock(tx, actor.workspaceId, 'spa:type:' + typeId); await this.enabled(tx, actor, typeId, true);
      await this.items.validateTemplate(tx, actor, typeId, input.templatePayload);
      const row = await tx.spaRecurrenceRule.create({ data: { workspaceId: actor.workspaceId, typeId, frequency: input.frequency,
        timezone: input.timezone, startsAt: new Date(input.startsAt), endsAt: input.endsAt ? new Date(input.endsAt) : null,
        interval: input.interval, byDay: input.byDay ?? [], maxInstances: input.maxInstances, customRule: input.customRule,
        templatePayload: input.templatePayload as Prisma.InputJsonObject, createdByUserId: actor.userId, nextScheduledFor: next(input) } });
      await evidence(tx, actor, 'SPA_TYPE', typeId, 'SPA_RECURRENCE_SCHEDULED', { ruleId: row.id, version: row.version });
      return row;
    }, { timeout: 30000 });
  }
  async list(actor: Principal, typeId: string, raw: unknown) {
    const scope = requirePermission(actor, 'SPA.RECURRENCE.READ');
    const query = parse(pageQuery, raw);
    return this.db.$transaction(async tx => {
      await this.enabled(tx, actor, typeId);
      const where = { workspaceId: actor.workspaceId, typeId, ...(scope !== 'WORKSPACE' ? { createdByUserId: actor.userId } : {}) };
      const rows = await tx.spaRecurrenceRule.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit, take: query.limit });
      const publication = await tx.spaSchemaVersion.findFirst({ where: { workspaceId: actor.workspaceId, typeId }, orderBy: { versionNumber: 'desc' } });
      const fields = publication ? parse(schemaSnapshot, publication.snapshot).fields : [];
      const data = [];
      for (const row of rows) {
        const payload = parse(spaCreateItemDto, row.templatePayload);
        for (const code of Object.keys(payload.fieldValues)) {
          const field = fields.find(f => f.code === code);
          if (!field || !(await this.policies.fieldAccess(tx, actor, typeId, field.id)).canView) delete payload.fieldValues[code];
        }
        data.push({ ...row, templatePayload: payload });
      }
      const total = await tx.spaRecurrenceRule.count({ where });
      return { data, meta: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) } };
    });
  }
  async update(actor: Principal, typeId: string, ruleId: string, raw: unknown) {
    requirePermission(actor, 'SPA.RECURRENCE.MANAGE', true);
    const input = parse(z.strictObject({ expectedVersion: version, templatePayload: spaCreateItemDto.optional(), rule: ruleSettings.partial().optional() }), raw);
    return this.db.$transaction(async tx => {
      await lock(tx, actor.workspaceId, 'spa:type:' + typeId); await this.enabled(tx, actor, typeId, true);
      const row = await this.row(tx, actor, typeId, ruleId); assertVersion(row.version, input.expectedVersion);
      const settings = parse(ruleSettings, { ...fromRow(row), ...input.rule }); definition(settings);
      const payload = input.templatePayload ?? parse(spaCreateItemDto, row.templatePayload);
      await this.items.validateTemplate(tx, actor, typeId, payload);
      const last = await tx.spaRecurrenceInstance.findFirst({ where: { workspaceId: actor.workspaceId, ruleId }, orderBy: { scheduledFor: 'desc' } });
      const after = last && last.scheduledFor > new Date() ? last.scheduledFor : new Date();
      const updated = await tx.spaRecurrenceRule.update({ where: { id: ruleId }, data: { frequency: settings.frequency,
        timezone: settings.timezone, startsAt: new Date(settings.startsAt), endsAt: settings.endsAt ? new Date(settings.endsAt) : null,
        interval: settings.interval, byDay: settings.byDay ?? [], maxInstances: settings.maxInstances ?? null, customRule: settings.customRule ?? null,
        templatePayload: payload as Prisma.InputJsonObject, nextScheduledFor: next(settings, after), version: { increment: 1 },
        lastErrorCode: null, failureCount: 0, nextRetryAt: null } });
      await evidence(tx, actor, 'SPA_TYPE', typeId, 'SPA_RECURRENCE_SCHEDULED', { ruleId, version: updated.version, futureInstancesOnly: true });
      return updated;
    }, { timeout: 30000 });
  }
  async pause(actor: Principal, typeId: string, ruleId: string, resume = false, raw: unknown = {}) {
    requirePermission(actor, 'SPA.RECURRENCE.MANAGE', true);
    parse(z.strictObject({}), raw);
    return this.db.$transaction(async tx => {
      await lock(tx, actor.workspaceId, 'spa:type:' + typeId); await this.enabled(tx, actor, typeId, resume);
      const row = await this.row(tx, actor, typeId, ruleId);
      if (row.isActive === resume) return row;
      if (resume) await this.items.validateTemplate(tx, actor, typeId, row.templatePayload);
      const result = await tx.spaRecurrenceRule.update({ where: { id: ruleId }, data: { isActive: resume,
        ...(resume ? { nextScheduledFor: next(fromRow(row), new Date()), nextRetryAt: null, lastErrorCode: null, failureCount: 0 } : {}), version: { increment: 1 } } });
      await evidence(tx, actor, 'SPA_TYPE', typeId, resume ? 'SPA_RECURRENCE_SCHEDULED' : 'SPA_RECURRENCE_PAUSED', { ruleId, version: result.version });
      return result;
    }, { timeout: 30000 });
  }
  async instances(actor: Principal, typeId: string, ruleId: string, raw: unknown) {
    const scope = requirePermission(actor, 'SPA.RECURRENCE.READ');
    const query = parse(pageQuery, raw);
    return this.db.$transaction(async tx => {
      await this.enabled(tx, actor, typeId); const row = await this.row(tx, actor, typeId, ruleId);
      if (scope !== 'WORKSPACE' && row.createdByUserId !== actor.userId) throw new AppError('PERMISSION_DENIED', 'Recurrence permission is required.', 403);
      const records = await tx.spaRecurrenceInstance.findMany({ where: { workspaceId: actor.workspaceId, ruleId }, orderBy: { scheduledFor: 'desc' } });
      const visible = [];
      for (const record of records) {
        const item = await tx.spaItem.findFirst({ where: { workspaceId: actor.workspaceId, typeId, id: record.itemId } });
        if (item && await this.policies.allowed(tx, actor, item, 'SPA.ITEM.READ')) visible.push(record);
      }
      return { data: visible.slice((query.page - 1) * query.limit, query.page * query.limit),
        meta: { page: query.page, limit: query.limit, total: visible.length, totalPages: Math.ceil(visible.length / query.limit) } };
    });
  }
  async runDue(limit = 10, now = new Date()) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid scheduler limit');
    const due = await this.db.spaRecurrenceRule.findMany({ where: { isActive: true, nextScheduledFor: { lte: now },
      OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }] }, orderBy: [{ nextScheduledFor: 'asc' }, { id: 'asc' }], take: limit });
    let generated = 0, failed = 0, skipped = 0;
    for (const candidate of due) {
      try {
        const result = await this.db.$transaction(async tx => {
          await lock(tx, candidate.workspaceId, 'spa:type:' + candidate.typeId);
          const rule = await tx.spaRecurrenceRule.findFirst({ where: { workspaceId: candidate.workspaceId, id: candidate.id, isActive: true,
            nextScheduledFor: { lte: now }, OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }] } });
          if (!rule?.nextScheduledFor) return false;
          const actor = await resolvePrincipal(tx, rule.workspaceId, rule.createdByUserId);
          requirePermission(actor, 'SPA.RECURRENCE.MANAGE', true); await this.enabled(tx, actor, rule.typeId, true);
          const scheduledFor = rule.nextScheduledFor;
          const count = await tx.spaRecurrenceInstance.count({ where: { workspaceId: rule.workspaceId, ruleId: rule.id } });
          if (rule.maxInstances && count >= rule.maxInstances) {
            await tx.spaRecurrenceRule.update({ where: { id: rule.id }, data: { nextScheduledFor: null } }); return false;
          }
          const existing = await tx.spaRecurrenceInstance.findUnique({ where: { workspaceId_ruleId_scheduledFor: {
            workspaceId: rule.workspaceId, ruleId: rule.id, scheduledFor } } });
          if (!existing) {
            const item = await this.items.createInTransaction(tx, actor, rule.typeId, rule.templatePayload,
              'spa.recurrence:' + rule.id + ':' + scheduledFor.toISOString());
            await tx.spaRecurrenceInstance.create({ data: { workspaceId: rule.workspaceId, ruleId: rule.id, scheduledFor, itemId: item.id, ruleVersion: rule.version } });
            await evidence(tx, actor, 'SPA_ITEM', item.id, 'SPA_RECURRING_ITEM_CREATED', { ruleId: rule.id, scheduledFor: scheduledFor.toISOString(), ruleVersion: rule.version });
          }
          await tx.spaRecurrenceRule.update({ where: { id: rule.id }, data: { nextScheduledFor: next(fromRow(rule), scheduledFor),
            failureCount: 0, lastErrorCode: null, nextRetryAt: null } });
          return !existing;
        }, { timeout: 30000 });
        if (result) generated++; else skipped++;
      } catch (error) {
        const attempts = candidate.failureCount + 1;
        await this.db.spaRecurrenceRule.updateMany({ where: { id: candidate.id, workspaceId: candidate.workspaceId,
          version: candidate.version, isActive: true, nextScheduledFor: candidate.nextScheduledFor }, data: { failureCount: { increment: 1 },
          lastErrorCode: isAppError(error) ? error.code : 'SPA_GENERATION_CONFLICT',
          nextRetryAt: new Date(now.getTime() + Math.min(3600000, 30000 * 2 ** Math.min(attempts, 7))), ...(attempts >= 10 ? { isActive: false } : {}) } });
        failed++;
      }
    }
    return { selected: due.length, generated, failed, skipped };
  }
}

