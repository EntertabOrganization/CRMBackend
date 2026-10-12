import { Prisma,type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors';
import { evidence,lock,requirePermission,resolvePrincipal,type Principal } from '../process-platform/context';
import { parse,uuid } from '../process-platform/dto';
import { inventoryVersion,assertInventoryVersion,documentType } from './dto';
import { inventoryDocumentPolicy } from './document-service';

export class InventoryPolicyService {
  constructor(private readonly db: PrismaClient) {}
  async documentPolicy(actor: Principal,type: string,raw?: unknown) {
    parse(documentType,type); requirePermission(actor,raw===undefined ? 'INVENTORY.SETTINGS_VIEW' : 'INVENTORY.SETTINGS_MANAGE',raw!==undefined);
    if (raw===undefined) {
      const settings = await this.db.inventorySettings.findUnique({ where: { workspaceId: actor.workspaceId } });
      const policies = (settings?.approvalPolicies ?? {}) as Record<string,unknown>;
      return { documentType: type,policy: parse(inventoryDocumentPolicy,policies[type] ?? {}),version: settings?.version.toString() ?? '0' };
    }
    const input = parse(z.strictObject({ expectedVersion: z.union([inventoryVersion,z.literal('0')]),policy: inventoryDocumentPolicy }),raw);
    return this.db.$transaction(async tx => {
      await lock(tx,actor.workspaceId,'inventory:configuration'); actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId); requirePermission(actor,'INVENTORY.SETTINGS_MANAGE',true);
      const current = await tx.inventorySettings.findUnique({ where: { workspaceId: actor.workspaceId } }); assertInventoryVersion(current?.version ?? 0n,input.expectedVersion);
      const roleIds = [...new Set([...(input.policy.approverRoleIds ?? []),...Object.values(input.policy.actions).flat()])];
      if (roleIds.length && await tx.role.count({ where: { workspaceId: actor.workspaceId,id: { in: roleIds },isDeleted: false } })!==roleIds.length)
        throw new AppError('INVENTORY_SETTINGS_INVALID','Every policy role must be active in this Workspace.',422);
      const before = (current?.approvalPolicies ?? {}) as Record<string,Prisma.InputJsonValue>;
      const policies = { ...before,[type]: input.policy as Prisma.InputJsonValue };
      const row = await tx.inventorySettings.upsert({ where: { workspaceId: actor.workspaceId },create: { workspaceId: actor.workspaceId,approvalPolicies: policies },update: { approvalPolicies: policies,version: { increment: 1 } } });
      await evidence(tx,actor,'INVENTORY_SETTINGS',actor.workspaceId,'INVENTORY_DOCUMENT_POLICY_CHANGED',{ documentType: type,before: before[type] ?? null,after: input.policy,version: row.version.toString() });
      return { documentType: type,policy: input.policy,version: row.version.toString() };
    });
  }
  async get(actor: Principal) {
    requirePermission(actor,'INVENTORY.SETTINGS_VIEW');
    return await this.db.inventorySettings.findUnique({ where: { workspaceId: actor.workspaceId } }) ?? { workspaceId: actor.workspaceId,isEnabled: true,costingMethod: 'FIFO',costingLocked: false,
      valuationGeneration: 1,allowNegativeStock: false,allowBackorderReservations: false,defaultReservationDays: 3,defaultWarehouseId: null,defaultAllocationStrategy: 'DEFAULT_WAREHOUSE',version: '0' };
  }
  async update(actor: Principal,raw: unknown) {
    requirePermission(actor,'INVENTORY.SETTINGS_MANAGE',true);
    const input = parse(z.strictObject({ expectedVersion: z.union([inventoryVersion,z.literal('0')]),allowNegativeStock: z.boolean().optional(),allowBackorderReservations: z.boolean().optional(),
      defaultReservationDays: z.number().int().min(1).max(365).optional(),allocationStrategy: z.enum(['DEFAULT_WAREHOUSE','MOST_AVAILABLE','PRIORITY_LIST','MANUAL']).optional() }),raw);
    return this.db.$transaction(async tx => {
      await lock(tx,actor.workspaceId,'inventory:configuration'); actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId); requirePermission(actor,'INVENTORY.SETTINGS_MANAGE',true);
      const current = await tx.inventorySettings.findUnique({ where: { workspaceId: actor.workspaceId } }); assertInventoryVersion(current?.version ?? 0n,input.expectedVersion);
      if (input.allowNegativeStock===false && await tx.inventoryBalance.count({ where: { workspaceId: actor.workspaceId,onHand: { lt: 0 } } }))
        throw new AppError('STOCK_RECONCILIATION_CONFLICT','Resolve negative stock before disabling this policy.',409);
      if (input.allowBackorderReservations===false && await tx.inventoryBalance.count({ where: { workspaceId: actor.workspaceId,reserved: { gt: tx.inventoryBalance.fields.onHand } } }))
        throw new AppError('RESERVATION_INSUFFICIENT_STOCK','Resolve outstanding backorders before disabling this policy.',409);
      const { expectedVersion,allocationStrategy,...values } = input;
      const data = { ...values,...(allocationStrategy ? { defaultAllocationStrategy: allocationStrategy } : {}) };
      const row = await tx.inventorySettings.upsert({ where: { workspaceId: actor.workspaceId },create: { workspaceId: actor.workspaceId,...data },update: { ...data,version: { increment: 1 } } });
      await evidence(tx,actor,'INVENTORY_SETTINGS',actor.workspaceId,'INVENTORY_SETTINGS_CHANGED',{ ...data,version: row.version.toString() }); return row;
    });
  }
  async numbering(actor: Principal,type: string,raw: unknown) {
    parse(documentType,type); requirePermission(actor,'INVENTORY.SETTINGS_MANAGE',true);
    const input = parse(z.strictObject({ expectedVersion: z.union([inventoryVersion,z.literal('0')]),prefixTemplate: z.string().max(100),padding: z.number().int().min(1).max(18),resetPolicy: z.enum(['NEVER','YEARLY','MONTHLY']) }),raw);
    if (/[\r\n\x00-\x1f]/.test(input.prefixTemplate) || /[{}]/.test(input.prefixTemplate.replace(/\{(?:YYYY|MM|TYPE)\}/g,'')))
      throw new AppError('INVALID_ARGUMENT','Number prefix contains an unsupported placeholder.',400);
    if (input.resetPolicy!=='NEVER' && !input.prefixTemplate.includes('{YYYY}') || input.resetPolicy==='MONTHLY' && !input.prefixTemplate.includes('{MM}'))
      throw new AppError('INVALID_ARGUMENT','Resetting numbering requires its year and month in the prefix.',400);
    return this.db.$transaction(async tx => {
      await lock(tx,actor.workspaceId,'inventory:configuration'); actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId); requirePermission(actor,'INVENTORY.SETTINGS_MANAGE',true);
      const where = { workspaceId_documentType: { workspaceId: actor.workspaceId,documentType: type } };
      const current = await tx.inventoryNumberingScheme.findUnique({ where }); assertInventoryVersion(current?.version ?? 0n,input.expectedVersion);
      const { expectedVersion,...data } = input;
      const row = await tx.inventoryNumberingScheme.upsert({ where,create: { workspaceId: actor.workspaceId,documentType: type,...data },update: { ...data,version: { increment: 1 } } });
      await evidence(tx,actor,'INVENTORY_NUMBERING',row.id,'INVENTORY_NUMBERING_CHANGED',{ documentType: type,...data,version: row.version.toString() }); return row;
    });
  }
}
