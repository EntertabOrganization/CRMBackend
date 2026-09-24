import type { ActorContext, AccessService } from '../access-service';
import { AppError } from '../errors';
import type { InMemoryStore } from '../store';
import type { ConditionDataType } from './field-types';
import type { FieldEntityType } from './types';

export type SystemFieldDescriptor = {
  /** Public system field key, e.g. "amount". Requirement targets are namespaced as `system:<key>`. */
  key: string;
  label: string;
  dataType: ConditionDataType;
  /** May a Required Field rule target this system field? Protected/internal columns must stay false. */
  requirementCapable: boolean;
  /** May the field be used as an operand in conditional requirement predicates? */
  conditionCapable: boolean;
  /** May the owning entity API write the field? */
  editable: boolean;
};

/**
 * Narrow contract a business entity implements to become field-capable. The engine never switches on table names;
 * it only talks to adapters, so Estimate/Invoice/Smart-Process style entities can register later without engine changes.
 */
export interface FieldCapableEntityAdapter {
  readonly entityType: FieldEntityType;
  readonly label: string;
  /** Does the entity have pipelines/stages (requirement rules may then be pipeline/stage scoped)? */
  readonly supportsPipeline: boolean;
  systemFields(): SystemFieldDescriptor[];
  /** Flat record of current system values used by the requirement evaluator. */
  systemValues(record: unknown): Record<string, unknown>;
  findRecord(workspaceId: string, entityId: string): unknown | undefined;
  canRead(actor: ActorContext, entityId: string): boolean;
  canUpdate(actor: ActorContext, entityId: string): boolean;
  canCreate(actor: ActorContext): boolean;
}

const f = (
  key: string,
  label: string,
  dataType: ConditionDataType,
  overrides: Partial<SystemFieldDescriptor> = {},
): SystemFieldDescriptor => ({
  key,
  label,
  dataType,
  requirementCapable: true,
  conditionCapable: true,
  editable: true,
  ...overrides,
});

const ADDRESS_FIELDS = [
  f('addressLine1', 'Address line 1', 'TEXT'),
  f('addressLine2', 'Address line 2', 'TEXT'),
  f('city', 'City', 'TEXT'),
  f('stateOrProvince', 'State / province', 'TEXT'),
  f('postalCode', 'Postal code', 'TEXT'),
  f('countryCode', 'Country', 'TEXT'),
];

const UTM_FIELDS = [
  f('utmSource', 'UTM source', 'TEXT'),
  f('utmMedium', 'UTM medium', 'TEXT'),
  f('utmCampaign', 'UTM campaign', 'TEXT'),
  f('utmContent', 'UTM content', 'TEXT'),
  f('utmTerm', 'UTM term', 'TEXT'),
];

export const LEAD_SYSTEM_FIELDS: SystemFieldDescriptor[] = [
  f('title', 'Title', 'TEXT', { requirementCapable: false }),
  f('firstName', 'First name', 'TEXT'),
  f('lastName', 'Last name', 'TEXT'),
  f('companyName', 'Company name', 'TEXT'),
  f('sourceId', 'Source', 'ENUM'),
  f('sourceDescription', 'Source description', 'TEXT'),
  f('estimatedAmount', 'Estimated amount', 'NUMBER'),
  f('currencyCode', 'Currency', 'TEXT'),
  ...ADDRESS_FIELDS,
  ...UTM_FIELDS,
  f('status', 'Status', 'ENUM', { requirementCapable: false, editable: false }),
  f('responsibleUserId', 'Responsible user', 'ENUM', { requirementCapable: false, editable: false }),
];

export const DEAL_SYSTEM_FIELDS: SystemFieldDescriptor[] = [
  f('title', 'Title', 'TEXT', { requirementCapable: false }),
  f('amount', 'Amount', 'NUMBER'),
  f('currencyCode', 'Currency', 'TEXT'),
  f('companyId', 'Company', 'ENUM'),
  f('sourceId', 'Source', 'ENUM'),
  f('sourceDescription', 'Source description', 'TEXT'),
  ...UTM_FIELDS,
  f('status', 'Status', 'ENUM', { requirementCapable: false, editable: false }),
  f('responsibleUserId', 'Responsible user', 'ENUM', { requirementCapable: false, editable: false }),
];

export const CONTACT_SYSTEM_FIELDS: SystemFieldDescriptor[] = [
  f('firstName', 'First name', 'TEXT', { requirementCapable: false }),
  f('lastName', 'Last name', 'TEXT', { requirementCapable: false }),
  ...ADDRESS_FIELDS,
  f('responsibleUserId', 'Responsible user', 'ENUM', { requirementCapable: false, editable: false }),
];

export const COMPANY_SYSTEM_FIELDS: SystemFieldDescriptor[] = [
  f('name', 'Name', 'TEXT', { requirementCapable: false }),
  ...ADDRESS_FIELDS,
  f('responsibleUserId', 'Responsible user', 'ENUM', { requirementCapable: false, editable: false }),
];

class CrmEntityAdapter implements FieldCapableEntityAdapter {
  constructor(
    readonly entityType: FieldEntityType,
    readonly label: string,
    readonly supportsPipeline: boolean,
    private readonly descriptors: SystemFieldDescriptor[],
    private readonly access: AccessService,
  ) {}

  systemFields() {
    return this.descriptors.map((descriptor) => ({ ...descriptor }));
  }

  systemValues(record: unknown): Record<string, unknown> {
    const source = record as Record<string, unknown>;
    const values: Record<string, unknown> = {};
    for (const descriptor of this.descriptors) values[descriptor.key] = source[descriptor.key];
    return values;
  }

  findRecord(workspaceId: string, entityId: string) {
    return this.access.crmRecord(workspaceId, this.entityType, entityId);
  }

  canRead(actor: ActorContext, entityId: string) {
    return this.access.canAccessCrmRecord(actor, this.entityType, entityId, 'read');
  }

  canUpdate(actor: ActorContext, entityId: string) {
    return this.access.canAccessCrmRecord(actor, this.entityType, entityId, 'update');
  }

  canCreate(actor: ActorContext) {
    return this.access.canCreateCrmRecord(actor, this.entityType);
  }
}

export class FieldEntityRegistry {
  private readonly adapters = new Map<FieldEntityType, FieldCapableEntityAdapter>();

  register(adapter: FieldCapableEntityAdapter) {
    this.adapters.set(adapter.entityType, adapter);
    return this;
  }

  has(entityType: string) {
    return this.adapters.has(entityType);
  }

  get(entityType: string): FieldCapableEntityAdapter {
    const adapter = this.adapters.get(entityType);
    if (!adapter) throw new AppError('ENTITY_TYPE_NOT_FIELD_CAPABLE', `${entityType} does not support custom fields.`, 400);
    return adapter;
  }

  types(): FieldEntityType[] {
    return [...this.adapters.keys()];
  }

  list() {
    return [...this.adapters.values()];
  }
}

export function createCrmFieldEntityRegistry(_store: InMemoryStore, access: AccessService) {
  return new FieldEntityRegistry()
    .register(new CrmEntityAdapter('LEAD', 'Lead', true, LEAD_SYSTEM_FIELDS, access))
    .register(new CrmEntityAdapter('CONTACT', 'Contact', false, CONTACT_SYSTEM_FIELDS, access))
    .register(new CrmEntityAdapter('COMPANY', 'Company', false, COMPANY_SYSTEM_FIELDS, access))
    .register(new CrmEntityAdapter('DEAL', 'Deal', true, DEAL_SYSTEM_FIELDS, access));
}
