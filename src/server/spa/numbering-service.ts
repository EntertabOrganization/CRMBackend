import { type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors';
import { assertVersion, evidence, lock, requirePermission, type Principal, type Tx } from '../process-platform/context';
import { parse, uuid, version } from '../process-platform/dto';

const scheme = z.strictObject({ expectedVersion: version, prefixTemplate: z.string().max(100),
  padding: z.number().int().min(1).max(18), resetPolicy: z.enum(['NEVER','YEARLY','MONTHLY']) });
function validateTemplate(template: string, resetPolicy: string) {
  const literals = template.replace(/\{YYYY\}|\{MM\}|\{0{1,18}\}/g, '');
  if (/[{}\r\n\u0000]/.test(literals) || (template.match(/\{0{1,18}\}/g)?.length ?? 0) > 1 ||
    resetPolicy !== 'NEVER' && !template.includes('{YYYY}') || resetPolicy === 'MONTHLY' && !template.includes('{MM}'))
    throw new AppError('SPA_NUMBER_FORMAT_INVALID', 'Number template must use supported tokens and identify its reset period.', 422);
}

export class SpaNumberingService {
  constructor(private readonly db: PrismaClient) {}
  private async type(tx: Tx, actor: Principal, typeId: string, writable = false) {
    parse(uuid, typeId);
    const row = await tx.spaEntityType.findFirst({ where: { workspaceId: actor.workspaceId, id: typeId, deletedAt: null } });
    if (!row) throw new AppError('SPA_TYPE_NOT_FOUND', 'Type was not found.', 404);
    if (writable && row.status === 'ARCHIVED') throw new AppError('SPA_TYPE_ARCHIVED', 'Archived Type is read-only.', 409);
  }
  async get(actor: Principal, typeId: string) {
    requirePermission(actor, 'SPA.TYPE.READ');
    return this.db.$transaction(async tx => {
      await this.type(tx, actor, typeId);
      return tx.spaNumberingScheme.findUniqueOrThrow({ where: { workspaceId_typeId: { workspaceId: actor.workspaceId, typeId } } });
    });
  }
  async update(actor: Principal, typeId: string, raw: unknown) {
    requirePermission(actor, 'SPA.TYPE.MANAGE', true);
    const { expectedVersion, ...changes } = parse(scheme, raw);
    validateTemplate(changes.prefixTemplate, changes.resetPolicy);
    return this.db.$transaction(async tx => {
      await lock(tx, actor.workspaceId, 'spa:type:' + typeId);
      await this.type(tx, actor, typeId, true);
      const row = await tx.spaNumberingScheme.findUniqueOrThrow({ where: { workspaceId_typeId: { workspaceId: actor.workspaceId, typeId } } });
      assertVersion(row.version, expectedVersion);
      if (changes.resetPolicy !== row.resetPolicy && await tx.spaItem.count({ where: { workspaceId: actor.workspaceId, typeId } }))
        throw new AppError('SPA_NUMBER_FORMAT_INVALID', 'Reset policy cannot change after numbers have been allocated.', 422);
      const result = await tx.spaNumberingScheme.update({ where: { id: row.id }, data: { ...changes, version: { increment: 1 } } });
      await evidence(tx, actor, 'SPA_TYPE', typeId, 'SPA_NUMBERING_UPDATED', { version: result.version });
      return result;
    });
  }
  async allocate(tx: Tx, actor: Principal, typeId: string, now = new Date()) {
    // Caller holds the Type lock, which also serializes template edits/publication with allocation.
    const row = await tx.spaNumberingScheme.findUniqueOrThrow({ where: { workspaceId_typeId: { workspaceId: actor.workspaceId, typeId } } });
    validateTemplate(row.prefixTemplate, row.resetPolicy);
    const workspace = await tx.workspace.findUniqueOrThrow({ where: { id: actor.workspaceId } });
    const settings = workspace.settings as Record<string, unknown>;
    const timeZone = typeof settings.timezone === 'string' ? settings.timezone : 'UTC';
    let parts: Intl.DateTimeFormatPart[];
    try { parts = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(now); }
    catch { throw new AppError('SPA_NUMBER_FORMAT_INVALID', 'Workspace timezone configuration is invalid.', 422); }
    const year = parts.find(p => p.type === 'year')!.value, month = parts.find(p => p.type === 'month')!.value;
    const periodKey = row.resetPolicy === 'YEARLY' ? year : row.resetPolicy === 'MONTHLY' ? year + '-' + month : 'ALL';
    const sequence = await tx.spaNumberingSequence.upsert({ where: { workspaceId_typeId_periodKey: {
      workspaceId: actor.workspaceId, typeId, periodKey } }, create: { workspaceId: actor.workspaceId, typeId, periodKey }, update: {} });
    await tx.spaNumberingSequence.update({ where: { id: sequence.id }, data: { nextValue: { increment: 1 } } });
    const prefix = row.prefixTemplate.replaceAll('{YYYY}', year).replaceAll('{MM}', month);
    const token = prefix.match(/\{(0{1,18})\}/);
    const digits = sequence.nextValue.toString().padStart(token ? token[1].length : row.padding, '0');
    const result = token ? prefix.replace(token[0], digits) : prefix + digits;
    if (await tx.spaItem.findFirst({ where: { workspaceId: actor.workspaceId, typeId, itemNumber: result } }))
      throw new AppError('SPA_NUMBER_FORMAT_INVALID', 'Number template conflicts with a historical number.', 409);
    return result;
  }
}
