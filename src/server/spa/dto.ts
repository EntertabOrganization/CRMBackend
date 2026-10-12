import { z } from 'zod';
import { code, name, version } from '../process-platform/dto';

export const capabilityKeys = ['PIPELINES', 'KANBAN', 'AUTOMATION', 'CLIENT', 'PRODUCTS', 'DOCUMENTS',
  'OBSERVERS', 'TASKS', 'CALENDAR', 'RECURRENCE', 'RECYCLE_BIN', 'NUMBERING', 'ACTIVITIES'] as const;
export const capabilityConfig = z.strictObject({
  retentionDays: z.number().int().min(1).max(3650).optional(),
});
export const capabilityInput = z.strictObject({ key: z.enum(capabilityKeys), enabled: z.boolean(),
  configuration: capabilityConfig.default({}) });
export const createType = z.strictObject({ code, name, pluralName: name,
  placement: z.enum(['CRM', 'AUTOMATION']), capabilities: z.array(capabilityInput).max(13).optional() });
export const updateType = z.strictObject({ expectedVersion: version, name: name.optional(), pluralName: name.optional(),
  placement: z.enum(['CRM', 'AUTOMATION']).optional(), description: z.string().max(10000).nullable().optional() });
export const typeAction = z.strictObject({ expectedVersion: version });
export const updateCapability = z.strictObject({ expectedVersion: version, enabled: z.boolean(),
  configuration: capabilityConfig });
export const listTypes = z.strictObject({ page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20), search: z.string().max(160).optional(),
  placement: z.enum(['CRM', 'AUTOMATION']).optional(), status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']).optional() });
