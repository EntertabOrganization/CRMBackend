import { AuditService } from './audit-service';
import type {
  CrmCommunicationType,
  CrmConversionAction,
  CrmCompany,
  CrmCompanyCommunication,
  CrmContact,
  CrmContactCommunication,
  CrmContactCompany,
  CrmDeal,
  CrmDealContact,
  CrmLead,
  CrmRecordEntityType,
  PermissionScope,
  CrmSource,
  User,
} from './domain';
import { badRequest, conflict, forbidden, notFound } from './errors';
import { CrmPipelineService } from './crm-pipeline-service';
import { applyCursorQuery, parseCursorQuery } from './query';
import { requireText } from './validation';
import type { InMemoryStore } from './store';
import type { FieldEngine } from './fields/field-engine';

type AddressInput = Partial<Pick<CrmContact, 'addressLine1' | 'addressLine2' | 'city' | 'stateOrProvince' | 'postalCode' | 'countryCode'>>;

type CommunicationInput = {
  type: CrmCommunicationType;
  value: string;
  label?: string | null;
  isPrimary?: boolean;
};

type LeadConversionInput = {
  expectedVersion: number;
  contact: {
    action: CrmConversionAction;
    contactId?: string;
    create?: {
      firstName?: string;
      lastName?: string;
      communications?: CommunicationInput[];
      customFields?: Record<string, unknown>;
    };
  };
  company: {
    action: CrmConversionAction;
    companyId?: string;
    create?: {
      name?: string;
      communications?: CommunicationInput[];
      customFields?: Record<string, unknown>;
    };
  };
  deal?: {
    action: 'CREATE' | 'NONE';
    title?: string;
    amount?: number | null;
    currencyCode?: string | null;
    customFields?: Record<string, unknown>;
  };
};

type ResponsibleRecord = CrmLead | CrmDeal | CrmContact | CrmCompany;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

function now() {
  return new Date();
}

function displayName(firstName: string, lastName: string) {
  return `${firstName.trim()} ${lastName.trim()}`.trim();
}

function normalizeCommunication(type: CrmCommunicationType, value: string) {
  const trimmed = value.trim();
  if (type === 'EMAIL') return trimmed.toLowerCase();
  if (type === 'PHONE') return trimmed.replace(/[^\d+]/g, '');
  if (type === 'WEB') return trimmed.toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  return trimmed.toLowerCase();
}

function normalizeCode(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

export class CrmCoreService {
  constructor(
    private readonly store: InMemoryStore,
    private readonly fields?: FieldEngine,
  ) {}

  /** Runs custom-field + requirement validation for the record about to be written (no-op without a field engine). */
  private prepareCustomFields(
    user: User,
    workspaceId: string,
    entityType: CrmRecordEntityType,
    record: ResponsibleRecord,
    supplied: unknown,
    isCreate: boolean,
  ) {
    if (!this.fields) return null;
    const access = this.fields.support.deps.access;
    const adapter = this.fields.support.deps.registry.get(entityType);
    const pipelined = record as { pipelineId?: string; stageId?: string };
    return this.fields.validateWrite({
      actor: access.actor(user, workspaceId),
      entityType,
      entityId: isCreate ? null : record.id,
      isCreate,
      supplied,
      systemState: adapter.systemValues(record),
      pipelineId: pipelined.pipelineId ?? null,
      stageId: pipelined.stageId ?? null,
    });
  }

  createSource(
    actor: User,
    workspaceId: string,
    input: {
      name: string;
      code?: string;
      sortOrder?: number;
      isSystem?: boolean;
    },
  ) {
    this.assertMembership(actor.id, workspaceId);
    const name = input.name.trim();
    const code = normalizeCode(input.code ?? name);
    if (!name || !code) throw badRequest('CRM_SOURCE_INVALID', 'CRM source name and code are required.');
    if (this.store.state.crmSources.some((source) => source.workspaceId === workspaceId && source.code === code)) {
      throw conflict('CRM_SOURCE_CODE_EXISTS', 'CRM source code already exists in this workspace.');
    }
    const source: CrmSource = {
      id: this.store.id(),
      workspaceId,
      name,
      code,
      sortOrder: input.sortOrder ?? this.store.state.crmSources.filter((item) => item.workspaceId === workspaceId).length + 1,
      isActive: true,
      isSystem: Boolean(input.isSystem),
    };
    this.store.state.crmSources.push(source);
    this.audit(actor.id, workspaceId, 'CRM.SOURCE.CREATED', 'CrmSource', source.id, null, source);
    return source;
  }

  listSources(actor: User, workspaceId: string, includeInactive = false) {
    this.assertMembership(actor.id, workspaceId);
    return this.store.state.crmSources
      .filter((source) => source.workspaceId === workspaceId && (includeInactive || source.isActive))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  }

  listLeads(actor: User, workspaceId: string, searchParams: URLSearchParams) {
    this.assertMembership(actor.id, workspaceId);
    const rows = this.store.state.crmLeads
      .filter((lead) => lead.workspaceId === workspaceId && !lead.isDeleted)
      .filter((lead) => this.canReadRecord(actor, workspaceId, 'LEAD', lead.id));
    return applyCursorQuery(rows as unknown as Array<typeof rows[number] & Record<string, unknown>>, parseCursorQuery(searchParams), {
      searchable: ['title', 'firstName', 'lastName', 'companyName', 'status'],
      filterable: ['status', 'responsibleUserId', 'pipelineId', 'stageId', 'sourceId', 'conversionStatus'],
      sortable: ['createdAt', 'updatedAt', 'title', 'status', 'id'],
      defaultSortBy: 'createdAt',
    });
  }

  listDeals(actor: User, workspaceId: string, searchParams: URLSearchParams) {
    this.assertMembership(actor.id, workspaceId);
    const rows = this.store.state.crmDeals
      .filter((deal) => deal.workspaceId === workspaceId && !deal.isDeleted)
      .filter((deal) => this.canReadRecord(actor, workspaceId, 'DEAL', deal.id));
    return applyCursorQuery(rows as unknown as Array<typeof rows[number] & Record<string, unknown>>, parseCursorQuery(searchParams), {
      searchable: ['title', 'status', 'currencyCode'],
      filterable: ['status', 'responsibleUserId', 'pipelineId', 'stageId', 'sourceId', 'companyId'],
      sortable: ['createdAt', 'updatedAt', 'title', 'status', 'id'],
      defaultSortBy: 'createdAt',
    });
  }

  getDealDetail(actor: User, workspaceId: string, dealId: string) {
    const deal = this.activeDeal(workspaceId, dealId);
    this.assertReadPermission(actor.id, workspaceId, 'DEAL', deal);
    const company = deal.companyId
      ? this.store.state.crmCompanies.find((item) => item.id === deal.companyId && item.workspaceId === workspaceId && !item.isDeleted) ?? null
      : null;
    const contactRelations = this.store.state.crmDealContacts
      .filter((relation) => relation.workspaceId === workspaceId && relation.dealId === deal.id)
      .sort((a, b) => a.sortOrder - b.sortOrder);
    const contacts = contactRelations.flatMap((relation) => {
      const contact = this.store.state.crmContacts.find((item) => item.id === relation.contactId && item.workspaceId === workspaceId && !item.isDeleted);
      if (!contact) return [];
      return [{
        id: contact.id,
        displayName: contact.displayName,
        role: relation.role,
        isPrimary: relation.isPrimary,
        communications: this.primaryContactCommunications(workspaceId, contact.id),
        address: this.addressSummary(contact),
      }];
    });
    return {
      deal,
      customerSummary: {
        company: company
          ? {
              id: company.id,
              name: company.name,
              communications: this.primaryCompanyCommunications(workspaceId, company.id),
              address: this.addressSummary(company),
            }
          : null,
        contacts,
      },
    };
  }

  listContacts(actor: User, workspaceId: string, searchParams: URLSearchParams) {
    this.assertMembership(actor.id, workspaceId);
    const rows = this.store.state.crmContacts
      .filter((contact) => contact.workspaceId === workspaceId && !contact.isDeleted)
      .filter((contact) => this.canReadRecord(actor, workspaceId, 'CONTACT', contact.id));
    return applyCursorQuery(rows as unknown as Array<typeof rows[number] & Record<string, unknown>>, parseCursorQuery(searchParams), {
      searchable: ['firstName', 'lastName', 'displayName'],
      filterable: ['responsibleUserId', 'city', 'countryCode'],
      sortable: ['createdAt', 'updatedAt', 'displayName', 'id'],
      defaultSortBy: 'createdAt',
    });
  }

  listCompanies(actor: User, workspaceId: string, searchParams: URLSearchParams) {
    this.assertMembership(actor.id, workspaceId);
    const rows = this.store.state.crmCompanies
      .filter((company) => company.workspaceId === workspaceId && !company.isDeleted)
      .filter((company) => this.canReadRecord(actor, workspaceId, 'COMPANY', company.id));
    return applyCursorQuery(rows as unknown as Array<typeof rows[number] & Record<string, unknown>>, parseCursorQuery(searchParams), {
      searchable: ['name'],
      filterable: ['responsibleUserId', 'city', 'countryCode'],
      sortable: ['createdAt', 'updatedAt', 'name', 'id'],
      defaultSortBy: 'createdAt',
    });
  }

  deactivateSource(actor: User, workspaceId: string, sourceId: string) {
    this.assertMembership(actor.id, workspaceId);
    const source = this.store.state.crmSources.find((item) => item.id === sourceId && item.workspaceId === workspaceId);
    if (!source) throw notFound('CRM_SOURCE');
    source.isActive = false;
    this.audit(actor.id, workspaceId, 'CRM.SOURCE.DEACTIVATED', 'CrmSource', source.id, null, source);
    return source;
  }

  createContact(
    actor: User,
    workspaceId: string,
    input: AddressInput & {
      firstName: string;
      lastName: string;
      responsibleUserId?: string;
      communications?: CommunicationInput[];
      forceCreate?: boolean;
      customFields?: Record<string, unknown>;
    },
  ) {
    return this.store.atomicSync(() => this.createContactUnsafe(actor, workspaceId, input));
  }

  private createContactUnsafe(
    actor: User,
    workspaceId: string,
    input: AddressInput & {
      firstName: string;
      lastName: string;
      responsibleUserId?: string;
      communications?: CommunicationInput[];
      forceCreate?: boolean;
      customFields?: Record<string, unknown>;
    },
  ) {
    this.assertMembership(actor.id, workspaceId);
    requireText(input.firstName, 'firstName');
    requireText(input.lastName, 'lastName');
    const communications = input.communications ?? [];
    this.assertNoDuplicateContactCommunications(workspaceId, communications, Boolean(input.forceCreate));
    const contact: CrmContact = {
      id: this.store.id(),
      workspaceId,
      firstName: input.firstName.trim(),
      lastName: input.lastName.trim(),
      displayName: displayName(input.firstName, input.lastName),
      responsibleUserId: input.responsibleUserId ?? actor.id,
      addressLine1: input.addressLine1 ?? null,
      addressLine2: input.addressLine2 ?? null,
      city: input.city ?? null,
      stateOrProvince: input.stateOrProvince ?? null,
      postalCode: input.postalCode ?? null,
      countryCode: input.countryCode ?? null,
      isArchived: false,
      archivedAt: null,
      archivedByUserId: null,
      isDeleted: false,
      deletedAt: null,
      deletedByUserId: null,
      createdAt: now(),
      updatedAt: now(),
      version: 1,
    };
    const prepared = this.prepareCustomFields(actor, workspaceId, 'CONTACT', contact, input.customFields, true);
    this.store.state.crmContacts.push(contact);
    if (prepared) this.fields!.commit(prepared, contact.id);
    for (const communication of communications) {
      this.addContactCommunication(actor, workspaceId, contact.id, communication);
    }
    this.audit(actor.id, workspaceId, 'CRM.CONTACT.CREATED', 'CrmContact', contact.id, null, { id: contact.id, displayName: contact.displayName });
    this.store.state.outboxEvents.push({ id: this.store.id(), workspaceId, eventType: 'CRM.CONTACT.CREATED', entityType: 'CONTACT', entityId: contact.id, actorUserId: actor.id, occurredAt: now(), payload: { entityVersion: contact.version } });
    return contact;
  }

  createCompany(
    actor: User,
    workspaceId: string,
    input: AddressInput & {
      name: string;
      responsibleUserId?: string;
      communications?: CommunicationInput[];
      forceCreate?: boolean;
      customFields?: Record<string, unknown>;
    },
  ) {
    return this.store.atomicSync(() => this.createCompanyUnsafe(actor, workspaceId, input));
  }

  private createCompanyUnsafe(
    actor: User,
    workspaceId: string,
    input: AddressInput & {
      name: string;
      responsibleUserId?: string;
      communications?: CommunicationInput[];
      forceCreate?: boolean;
      customFields?: Record<string, unknown>;
    },
  ) {
    this.assertMembership(actor.id, workspaceId);
    requireText(input.name, 'name');
    const communications = input.communications ?? [];
    this.assertNoDuplicateCompanyCommunications(workspaceId, communications, Boolean(input.forceCreate));
    const company: CrmCompany = {
      id: this.store.id(),
      workspaceId,
      name: input.name.trim(),
      responsibleUserId: input.responsibleUserId ?? actor.id,
      addressLine1: input.addressLine1 ?? null,
      addressLine2: input.addressLine2 ?? null,
      city: input.city ?? null,
      stateOrProvince: input.stateOrProvince ?? null,
      postalCode: input.postalCode ?? null,
      countryCode: input.countryCode ?? null,
      isArchived: false,
      archivedAt: null,
      archivedByUserId: null,
      isDeleted: false,
      deletedAt: null,
      deletedByUserId: null,
      createdAt: now(),
      updatedAt: now(),
      version: 1,
    };
    const prepared = this.prepareCustomFields(actor, workspaceId, 'COMPANY', company, input.customFields, true);
    this.store.state.crmCompanies.push(company);
    if (prepared) this.fields!.commit(prepared, company.id);
    for (const communication of communications) {
      this.addCompanyCommunication(actor, workspaceId, company.id, communication);
    }
    this.audit(actor.id, workspaceId, 'CRM.COMPANY.CREATED', 'CrmCompany', company.id, null, { id: company.id, name: company.name });
    this.store.state.outboxEvents.push({ id: this.store.id(), workspaceId, eventType: 'CRM.COMPANY.CREATED', entityType: 'COMPANY', entityId: company.id, actorUserId: actor.id, occurredAt: now(), payload: { entityVersion: company.version } });
    return company;
  }

  addContactCommunication(actor: User, workspaceId: string, contactId: string, input: CommunicationInput) {
    this.assertMembership(actor.id, workspaceId);
    this.activeContact(workspaceId, contactId);
    const normalizedValue = normalizeCommunication(input.type, input.value);
    if (!normalizedValue) throw badRequest('CRM_COMMUNICATION_INVALID', 'Communication value is required.');
    const existingForType = this.store.state.crmContactCommunications.filter(
      (item) => item.workspaceId === workspaceId && item.contactId === contactId && item.type === input.type,
    );
    const isPrimary = input.isPrimary ?? existingForType.length === 0;
    if (isPrimary) this.clearContactPrimaryCommunication(contactId, input.type);
    const communication: CrmContactCommunication = {
      id: this.store.id(),
      workspaceId,
      contactId,
      type: input.type,
      value: input.value.trim(),
      normalizedValue,
      label: input.label ?? null,
      isPrimary,
      createdAt: now(),
      updatedAt: now(),
    };
    this.store.state.crmContactCommunications.push(communication);
    this.audit(actor.id, workspaceId, 'CRM.CONTACT.COMMUNICATION_ADDED', 'CrmContact', contactId, null, {
      id: communication.id,
      type: communication.type,
    });
    return communication;
  }

  addCompanyCommunication(actor: User, workspaceId: string, companyId: string, input: CommunicationInput) {
    this.assertMembership(actor.id, workspaceId);
    this.activeCompany(workspaceId, companyId);
    const normalizedValue = normalizeCommunication(input.type, input.value);
    if (!normalizedValue) throw badRequest('CRM_COMMUNICATION_INVALID', 'Communication value is required.');
    const existingForType = this.store.state.crmCompanyCommunications.filter(
      (item) => item.workspaceId === workspaceId && item.companyId === companyId && item.type === input.type,
    );
    const isPrimary = input.isPrimary ?? existingForType.length === 0;
    if (isPrimary) this.clearCompanyPrimaryCommunication(companyId, input.type);
    const communication: CrmCompanyCommunication = {
      id: this.store.id(),
      workspaceId,
      companyId,
      type: input.type,
      value: input.value.trim(),
      normalizedValue,
      label: input.label ?? null,
      isPrimary,
      createdAt: now(),
      updatedAt: now(),
    };
    this.store.state.crmCompanyCommunications.push(communication);
    this.audit(actor.id, workspaceId, 'CRM.COMPANY.COMMUNICATION_ADDED', 'CrmCompany', companyId, null, {
      id: communication.id,
      type: communication.type,
    });
    return communication;
  }

  linkContactCompany(
    actor: User,
    workspaceId: string,
    input: {
      contactId: string;
      companyId: string;
      jobTitle?: string | null;
      department?: string | null;
      isPrimary?: boolean;
      sortOrder?: number;
    },
    idempotencyKey?: string,
  ) {
    const idempotent = this.findIdempotentReplay(workspaceId, actor.id, 'crm.contact.company.link', input, idempotencyKey);
    if (idempotent) return idempotent as CrmContactCompany;
    this.assertMembership(actor.id, workspaceId);
    this.activeContact(workspaceId, input.contactId);
    this.activeCompany(workspaceId, input.companyId);
    const existing = this.store.state.crmContactCompanies.find(
      (item) => item.contactId === input.contactId && item.companyId === input.companyId,
    );
    if (existing) throw conflict('CRM_RELATION_EXISTS', 'Contact is already linked to this company.');
    const existingRelations = this.store.state.crmContactCompanies.filter((item) => item.workspaceId === workspaceId && item.contactId === input.contactId);
    const isPrimary = input.isPrimary ?? existingRelations.length === 0;
    if (isPrimary) this.clearPrimaryContactCompany(input.contactId);
    const relation: CrmContactCompany = {
      id: this.store.id(),
      workspaceId,
      contactId: input.contactId,
      companyId: input.companyId,
      jobTitle: input.jobTitle ?? null,
      department: input.department ?? null,
      isPrimary,
      sortOrder: input.sortOrder ?? existingRelations.length + 1,
      createdAt: now(),
      updatedAt: now(),
    };
    this.store.state.crmContactCompanies.push(relation);
    this.audit(actor.id, workspaceId, 'CRM.CONTACT.COMPANY_LINKED', 'CrmContact', input.contactId, null, relation);
    this.storeIdempotentResponse(workspaceId, actor.id, 'crm.contact.company.link', input, idempotencyKey, relation);
    return relation;
  }

  removeContactCompany(actor: User, workspaceId: string, relationId: string, replacementPrimaryCompanyId?: string) {
    this.assertMembership(actor.id, workspaceId);
    const relation = this.store.state.crmContactCompanies.find((item) => item.id === relationId && item.workspaceId === workspaceId);
    if (!relation) throw notFound('CRM_CONTACT_COMPANY');
    const siblingRelations = this.store.state.crmContactCompanies.filter((item) => item.contactId === relation.contactId && item.id !== relation.id);
    if (relation.isPrimary && siblingRelations.length > 0) {
      if (!replacementPrimaryCompanyId) {
        throw conflict('CRM_PRIMARY_RELATION_REPLACEMENT_REQUIRED', 'Removing a primary company requires an explicit replacement.');
      }
      const replacement = siblingRelations.find((item) => item.companyId === replacementPrimaryCompanyId);
      if (!replacement) throw badRequest('CRM_PRIMARY_RELATION_REPLACEMENT_REQUIRED', 'Replacement primary company must already be linked to the contact.');
      replacement.isPrimary = true;
      replacement.updatedAt = now();
    }
    this.store.state.crmContactCompanies = this.store.state.crmContactCompanies.filter((item) => item.id !== relation.id);
    this.audit(actor.id, workspaceId, 'CRM.CONTACT.COMPANY_UNLINKED', 'CrmContact', relation.contactId, relation, null);
    return { id: relation.id };
  }

  softDeleteCompany(actor: User, workspaceId: string, companyId: string) {
    this.assertMembership(actor.id, workspaceId);
    const company = this.activeCompany(workspaceId, companyId);
    const activeDeal = this.store.state.crmDeals.find((deal) => deal.workspaceId === workspaceId && deal.companyId === companyId && !deal.isDeleted);
    if (activeDeal) {
      throw conflict('CRM_ACTIVE_REFERENCES_EXIST', 'Company is referenced by active deals.');
    }
    company.isDeleted = true;
    company.deletedAt = now();
    company.deletedByUserId = actor.id;
    company.version += 1;
    this.audit(actor.id, workspaceId, 'CRM.COMPANY.SOFT_DELETED', 'CrmCompany', company.id, null, { id: company.id });
    return company;
  }

  convertLead(actor: User, workspaceId: string, leadId: string, input: LeadConversionInput, idempotencyKey?: string) {
    this.assertMembership(actor.id, workspaceId);
    const operation = `crm.lead.convert:${leadId}`;
    const requestHash = JSON.stringify(input);
    if (idempotencyKey) {
      const existing = this.store.state.idempotencyRecords.find(
        (item) =>
          item.workspaceId === workspaceId &&
          item.actorUserId === actor.id &&
          item.operation === operation &&
          item.idempotencyKey === idempotencyKey &&
          item.expiresAt > now(),
      );
      if (existing) {
        if (existing.requestHash !== requestHash) throw conflict('IDEMPOTENCY_KEY_REUSED', 'Idempotency key was reused with a different payload.');
        return existing.response;
      }
    }

    const snapshot = this.store.cloneState();
    try {
      const lead = this.activeLead(workspaceId, leadId);
      if (lead.version !== input.expectedVersion) throw conflict('CRM_VERSION_CONFLICT', 'CRM record version is stale.');
      if (lead.conversionStatus === 'CONVERTED') throw conflict('CRM_ALREADY_CONVERTED', 'Lead has already been converted.');

      const contact = this.resolveConversionContact(actor, workspaceId, lead, input.contact);
      const company = this.resolveConversionCompany(actor, workspaceId, lead, input.company);
      if (!contact && !company) throw badRequest('CRM_CONVERSION_INVALID', 'Lead conversion must result in a contact or company.');

      if (contact && company && !this.store.state.crmContactCompanies.some((item) => item.contactId === contact.id && item.companyId === company.id)) {
        this.linkContactCompany(actor, workspaceId, { contactId: contact.id, companyId: company.id });
      }

      let deal = null;
      if (input.deal?.action === 'CREATE') {
        deal = new CrmPipelineService(this.store, undefined, this.fields).createDeal(actor, workspaceId, {
          customFields: input.deal.customFields,
          title: input.deal.title ?? lead.title,
          companyId: company?.id ?? null,
          contactIds: contact ? [contact.id] : [],
          amount: input.deal.amount ?? lead.estimatedAmount ?? undefined,
          currencyCode: input.deal.currencyCode ?? lead.currencyCode ?? undefined,
          sourceId: lead.sourceId ?? null,
          sourceDescription: lead.sourceDescription ?? null,
          utmSource: lead.utmSource ?? null,
          utmMedium: lead.utmMedium ?? null,
          utmCampaign: lead.utmCampaign ?? null,
          utmContent: lead.utmContent ?? null,
          utmTerm: lead.utmTerm ?? null,
          originSystem: lead.originSystem ?? null,
          originExternalId: lead.originExternalId ?? null,
          originVersion: lead.originVersion ?? null,
        });
      }

      lead.conversionStatus = 'CONVERTED';
      lead.convertedAt = now();
      lead.convertedByUserId = actor.id;
      lead.version += 1;
      lead.updatedAt = now();

      const conversion = {
        id: this.store.id(),
        workspaceId,
        leadId: lead.id,
        contactId: contact?.id ?? null,
        companyId: company?.id ?? null,
        dealId: deal?.id ?? null,
        convertedByUserId: actor.id,
        convertedAt: now(),
      };
      this.store.state.crmLeadConversions.push(conversion);
      this.audit(actor.id, workspaceId, 'CRM.LEAD.CONVERTED', 'CrmLead', lead.id, null, conversion);
      this.store.state.outboxEvents.push({
        id: this.store.id(),
        workspaceId,
        eventType: 'CRM.LEAD.CONVERTED',
        entityType: 'LEAD',
        entityId: lead.id,
        actorUserId: actor.id,
        occurredAt: now(),
        payload: {
          leadId: lead.id,
          contactId: contact?.id ?? null,
          companyId: company?.id ?? null,
          dealId: deal?.id ?? null,
          entityVersion: lead.version,
        },
      });

      const response = {
        lead,
        conversion,
        contact,
        company,
        deal,
      } as Record<string, unknown>;
      if (idempotencyKey) {
        this.store.state.idempotencyRecords.push({
          id: this.store.id(),
          workspaceId,
          actorUserId: actor.id,
          operation,
          idempotencyKey,
          requestHash,
          response,
          expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
          createdAt: now(),
        });
      }
      return response;
    } catch (error) {
      this.store.state = snapshot;
      throw error;
    }
  }

  linkDealContact(
    actor: User,
    workspaceId: string,
    input: {
      dealId: string;
      contactId: string;
      role?: string | null;
      isPrimary?: boolean;
      sortOrder?: number;
    },
    idempotencyKey?: string,
  ) {
    const idempotent = this.findIdempotentReplay(workspaceId, actor.id, 'crm.deal.contact.link', input, idempotencyKey);
    if (idempotent) return idempotent as CrmDealContact;
    this.assertMembership(actor.id, workspaceId);
    this.activeDeal(workspaceId, input.dealId);
    this.activeContact(workspaceId, input.contactId);
    const existing = this.store.state.crmDealContacts.find((item) => item.dealId === input.dealId && item.contactId === input.contactId);
    if (existing) throw conflict('CRM_RELATION_EXISTS', 'Contact is already linked to this deal.');
    const existingRelations = this.store.state.crmDealContacts.filter((item) => item.workspaceId === workspaceId && item.dealId === input.dealId);
    const isPrimary = input.isPrimary ?? existingRelations.length === 0;
    if (isPrimary) this.clearPrimaryDealContact(input.dealId);
    const relation: CrmDealContact = {
      id: this.store.id(),
      workspaceId,
      dealId: input.dealId,
      contactId: input.contactId,
      role: input.role ?? null,
      isPrimary,
      sortOrder: input.sortOrder ?? existingRelations.length + 1,
      createdAt: now(),
      updatedAt: now(),
    };
    this.store.state.crmDealContacts.push(relation);
    this.audit(actor.id, workspaceId, 'CRM.DEAL.CONTACT_LINKED', 'CrmDeal', input.dealId, null, relation);
    this.storeIdempotentResponse(workspaceId, actor.id, 'crm.deal.contact.link', input, idempotencyKey, relation);
    return relation;
  }

  archiveContact(actor: User, workspaceId: string, contactId: string) {
    return this.archiveRecord(actor, workspaceId, this.activeContact(workspaceId, contactId), 'CrmContact', 'CRM.CONTACT.ARCHIVED');
  }

  restoreArchivedContact(actor: User, workspaceId: string, contactId: string) {
    const contact = this.store.state.crmContacts.find((item) => item.id === contactId && item.workspaceId === workspaceId && !item.isDeleted);
    if (!contact) throw notFound('CRM_CONTACT');
    return this.restoreArchivedRecord(actor, workspaceId, contact, 'CrmContact', 'CRM.CONTACT.ARCHIVE_RESTORED');
  }

  softDeleteContact(actor: User, workspaceId: string, contactId: string) {
    this.assertMembership(actor.id, workspaceId);
    const contact = this.activeContact(workspaceId, contactId);
    const activeDealContact = this.store.state.crmDealContacts.find((relation) => {
      const deal = this.store.state.crmDeals.find((item) => item.id === relation.dealId);
      return relation.workspaceId === workspaceId && relation.contactId === contactId && deal && !deal.isDeleted;
    });
    const conversion = this.store.state.crmLeadConversions.find((item) => item.workspaceId === workspaceId && item.contactId === contactId);
    if (activeDealContact || conversion) throw conflict('CRM_ACTIVE_REFERENCES_EXIST', 'Contact is referenced by active business records.');
    return this.softDeleteRecord(actor, workspaceId, contact, 'CrmContact', 'CRM.CONTACT.SOFT_DELETED');
  }

  restoreDeletedContact(actor: User, workspaceId: string, contactId: string) {
    const contact = this.store.state.crmContacts.find((item) => item.id === contactId && item.workspaceId === workspaceId && item.isDeleted);
    if (!contact) throw notFound('CRM_CONTACT');
    return this.restoreDeletedRecord(actor, workspaceId, contact, 'CrmContact', 'CRM.CONTACT.RESTORED');
  }

  hardDeleteContact(actor: User, workspaceId: string, contactId: string) {
    this.assertMembership(actor.id, workspaceId);
    const contact = this.store.state.crmContacts.find((item) => item.id === contactId && item.workspaceId === workspaceId && item.isDeleted);
    if (!contact) throw conflict('CRM_SOFT_DELETE_REQUIRED', 'Contact must be soft-deleted before hard delete.');
    const before = { ...contact };
    this.store.state.crmContactCommunications = this.store.state.crmContactCommunications.filter((item) => item.contactId !== contactId);
    this.store.state.crmContactCompanies = this.store.state.crmContactCompanies.filter((item) => item.contactId !== contactId);
    this.store.state.crmContacts = this.store.state.crmContacts.filter((item) => item.id !== contactId);
    this.audit(actor.id, workspaceId, 'CRM.CONTACT.HARD_DELETED', 'CrmContact', contactId, before, null);
    return { id: contactId };
  }

  archiveLead(actor: User, workspaceId: string, leadId: string) {
    return this.archiveRecord(actor, workspaceId, this.activeLead(workspaceId, leadId), 'CrmLead', 'CRM.LEAD.ARCHIVED');
  }

  restoreArchivedLead(actor: User, workspaceId: string, leadId: string) {
    const lead = this.store.state.crmLeads.find((item) => item.id === leadId && item.workspaceId === workspaceId && !item.isDeleted);
    if (!lead) throw notFound('CRM_LEAD');
    return this.restoreArchivedRecord(actor, workspaceId, lead, 'CrmLead', 'CRM.LEAD.ARCHIVE_RESTORED');
  }

  softDeleteLead(actor: User, workspaceId: string, leadId: string) {
    this.assertMembership(actor.id, workspaceId);
    return this.softDeleteRecord(actor, workspaceId, this.activeLead(workspaceId, leadId), 'CrmLead', 'CRM.LEAD.SOFT_DELETED');
  }

  restoreDeletedLead(actor: User, workspaceId: string, leadId: string) {
    const lead = this.store.state.crmLeads.find((item) => item.id === leadId && item.workspaceId === workspaceId && item.isDeleted);
    if (!lead) throw notFound('CRM_LEAD');
    return this.restoreDeletedRecord(actor, workspaceId, lead, 'CrmLead', 'CRM.LEAD.RESTORED');
  }

  archiveDeal(actor: User, workspaceId: string, dealId: string) {
    return this.archiveRecord(actor, workspaceId, this.activeDeal(workspaceId, dealId), 'CrmDeal', 'CRM.DEAL.ARCHIVED');
  }

  softDeleteDeal(actor: User, workspaceId: string, dealId: string) {
    this.assertMembership(actor.id, workspaceId);
    return this.softDeleteRecord(actor, workspaceId, this.activeDeal(workspaceId, dealId), 'CrmDeal', 'CRM.DEAL.SOFT_DELETED');
  }

  assignRecord(
    actor: User,
    workspaceId: string,
    entityType: CrmRecordEntityType,
    recordId: string,
    input: { responsibleUserId: string; expectedVersion: number },
    idempotencyKey?: string,
  ) {
    const operation = `crm.${entityType.toLowerCase()}.assign:${recordId}`;
    const idempotent = this.findIdempotentReplay(workspaceId, actor.id, operation, input, idempotencyKey);
    if (idempotent) return idempotent as ResponsibleRecord;
    const record = this.activeCrmRecord(workspaceId, entityType, recordId);
    this.assertRecordPermission(actor.id, workspaceId, this.permissionKey(entityType, 'assign'), record);
    this.assertActiveWorkspaceMember(workspaceId, input.responsibleUserId);
    if (record.version !== input.expectedVersion) throw conflict('CRM_VERSION_CONFLICT', 'CRM record version is stale.');
    const before = { responsibleUserId: record.responsibleUserId, version: record.version };
    record.responsibleUserId = input.responsibleUserId;
    record.version += 1;
    record.updatedAt = now();
    this.audit(actor.id, workspaceId, `CRM.${entityType}.ASSIGNED`, this.entityClass(entityType), record.id, before, {
      responsibleUserId: record.responsibleUserId,
      version: record.version,
    });
    this.store.state.outboxEvents.push({
      id: this.store.id(),
      workspaceId,
      eventType: `CRM.${entityType}.ASSIGNED`,
      entityType,
      entityId: record.id,
      actorUserId: actor.id,
      occurredAt: now(),
      payload: { fromUserId: before.responsibleUserId, toUserId: record.responsibleUserId, entityVersion: record.version },
    });
    this.storeIdempotentResponse(workspaceId, actor.id, operation, input, idempotencyKey, record);
    return record;
  }

  addObserver(actor: User, workspaceId: string, entityType: CrmRecordEntityType, recordId: string, userId: string) {
    const record = this.activeCrmRecord(workspaceId, entityType, recordId);
    this.assertRecordPermission(actor.id, workspaceId, this.permissionKey(entityType, 'update'), record);
    this.assertActiveWorkspaceMember(workspaceId, userId);
    const existing = this.store.state.crmRecordObservers.find(
      (observer) =>
        observer.workspaceId === workspaceId &&
        observer.entityType === entityType &&
        observer.recordId === recordId &&
        observer.userId === userId,
    );
    if (existing) return existing;
    const observer = {
      id: this.store.id(),
      workspaceId,
      entityType,
      recordId,
      userId,
      createdByUserId: actor.id,
      createdAt: now(),
    };
    this.store.state.crmRecordObservers.push(observer);
    this.audit(actor.id, workspaceId, `CRM.${entityType}.OBSERVER_ADDED`, this.entityClass(entityType), recordId, null, observer);
    return observer;
  }

  removeObserver(actor: User, workspaceId: string, entityType: CrmRecordEntityType, recordId: string, userId: string) {
    const record = this.activeCrmRecord(workspaceId, entityType, recordId);
    this.assertRecordPermission(actor.id, workspaceId, this.permissionKey(entityType, 'update'), record);
    const existing = this.store.state.crmRecordObservers.find(
      (observer) =>
        observer.workspaceId === workspaceId &&
        observer.entityType === entityType &&
        observer.recordId === recordId &&
        observer.userId === userId,
    );
    if (!existing) throw notFound('CRM_RECORD_OBSERVER');
    this.store.state.crmRecordObservers = this.store.state.crmRecordObservers.filter((observer) => observer.id !== existing.id);
    this.audit(actor.id, workspaceId, `CRM.${entityType}.OBSERVER_REMOVED`, this.entityClass(entityType), recordId, existing, null);
    return { id: existing.id };
  }

  // ---- update / detail with custom fields ------------------------------------------------------------------------

  private static readonly ADDRESS_KEYS = ['addressLine1', 'addressLine2', 'city', 'stateOrProvince', 'postalCode', 'countryCode'];
  private static readonly UTM_KEYS = ['utmSource', 'utmMedium', 'utmCampaign', 'utmContent', 'utmTerm'];

  private updatableKeys(entityType: CrmRecordEntityType): { text: string[]; nullableText: string[]; numbers: string[] } {
    const address = CrmCoreService.ADDRESS_KEYS;
    switch (entityType) {
      case 'LEAD':
        return {
          text: ['title'],
          nullableText: ['firstName', 'lastName', 'companyName', 'sourceDescription', 'currencyCode', ...address, ...CrmCoreService.UTM_KEYS],
          numbers: ['estimatedAmount'],
        };
      case 'DEAL':
        return { text: ['title'], nullableText: ['sourceDescription', 'currencyCode', ...CrmCoreService.UTM_KEYS], numbers: ['amount'] };
      case 'CONTACT':
        return { text: ['firstName', 'lastName'], nullableText: [...address], numbers: [] };
      case 'COMPANY':
        return { text: ['name'], nullableText: [...address], numbers: [] };
    }
  }

  /** PATCH semantics: only supplied keys change; system + custom values are validated and written together. */
  updateRecord(
    actor: User,
    workspaceId: string,
    entityType: CrmRecordEntityType,
    recordId: string,
    input: Record<string, unknown>,
    idempotencyKey?: string,
  ) {
    const operation = `crm.${entityType.toLowerCase()}.update:${recordId}`;
    const idempotent = this.findIdempotentReplay(workspaceId, actor.id, operation, input, idempotencyKey);
    if (idempotent) return idempotent as ResponsibleRecord;
    return this.store.atomicSync(() => {
      const record = this.activeCrmRecord(workspaceId, entityType, recordId);
      this.assertRecordPermission(actor.id, workspaceId, this.permissionKey(entityType, 'update'), record);
      if (typeof input.expectedVersion !== 'number') throw badRequest('CRM_VERSION_REQUIRED', 'expectedVersion is required.');
      if (record.version !== input.expectedVersion) throw conflict('CRM_VERSION_CONFLICT', 'CRM record version is stale.');
      const keys = this.updatableKeys(entityType);
      const allowed = new Set([...keys.text, ...keys.nullableText, ...keys.numbers, 'sourceId', 'companyId', 'customFields', 'expectedVersion', 'idempotencyKey']);
      const unknown = Object.keys(input).filter((key) => !allowed.has(key));
      if (unknown.length > 0) throw badRequest('CRM_FIELD_NOT_UPDATABLE', `These fields cannot be updated here: ${unknown.join(', ')}.`, { fields: unknown });

      const changes: Record<string, unknown> = {};
      for (const key of keys.text) {
        if (input[key] !== undefined) changes[key] = requireText(input[key], key);
      }
      for (const key of keys.nullableText) {
        if (input[key] === undefined) continue;
        if (input[key] !== null && typeof input[key] !== 'string') throw badRequest('VALIDATION_ERROR', `${key} must be a string or null.`);
        changes[key] = input[key] === null ? null : (input[key] as string).trim() || null;
      }
      for (const key of keys.numbers) {
        if (input[key] === undefined) continue;
        if (input[key] !== null && (typeof input[key] !== 'number' || !Number.isFinite(input[key]))) throw badRequest('VALIDATION_ERROR', `${key} must be a number or null.`);
        changes[key] = input[key];
      }
      if ((entityType === 'LEAD' || entityType === 'DEAL') && input.sourceId !== undefined) {
        if (input.sourceId !== null) {
          const source = this.store.state.crmSources.find((item) => item.id === input.sourceId && item.workspaceId === workspaceId && item.isActive);
          if (!source) throw notFound('CRM_SOURCE');
        }
        changes.sourceId = input.sourceId;
      }
      if (entityType === 'DEAL' && input.companyId !== undefined) {
        if (input.companyId !== null) this.activeCompany(workspaceId, input.companyId as string);
        else if (!this.store.state.crmDealContacts.some((item) => item.dealId === recordId)) {
          throw badRequest('CRM_CUSTOMER_REQUIRED', 'A deal requires a company or at least one contact.');
        }
        changes.companyId = input.companyId;
      }

      const target = record as unknown as Record<string, unknown>;
      const preview = { ...target, ...changes } as unknown as ResponsibleRecord;
      const prepared = this.prepareCustomFields(actor, workspaceId, entityType, preview, input.customFields, false);
      const before: Record<string, unknown> = {};
      for (const key of Object.keys(changes)) before[key] = target[key];
      Object.assign(target, changes);
      if (entityType === 'CONTACT') (record as CrmContact).displayName = displayName((record as CrmContact).firstName, (record as CrmContact).lastName);
      if (prepared) this.fields!.commit(prepared, record.id);
      record.version += 1;
      record.updatedAt = now();
      const changedFields = [...Object.keys(changes), ...(prepared ? [...prepared.changes.values()].map((entry) => `customFields.${entry.field.code}`) : [])];
      this.audit(actor.id, workspaceId, `CRM.${entityType}.UPDATED`, this.entityClass(entityType), record.id, before, { ...changes, version: record.version });
      this.store.state.outboxEvents.push({
        id: this.store.id(),
        workspaceId,
        eventType: `CRM.${entityType}.UPDATED`,
        entityType,
        entityId: record.id,
        actorUserId: actor.id,
        occurredAt: now(),
        payload: { entityVersion: record.version, changedFields },
      });
      this.storeIdempotentResponse(workspaceId, actor.id, operation, input, idempotencyKey, record);
      return record;
    });
  }

  /** Detail read for any CRM record: normal read permission applies, custom fields are authorized per field. */
  getRecord(actor: User, workspaceId: string, entityType: CrmRecordEntityType, recordId: string) {
    const record = this.activeCrmRecord(workspaceId, entityType, recordId);
    this.assertReadPermission(actor.id, workspaceId, entityType, record);
    return record;
  }

  canReadRecord(actor: User, workspaceId: string, entityType: CrmRecordEntityType, recordId: string) {
    try {
      const record = this.activeCrmRecord(workspaceId, entityType, recordId);
      this.assertReadPermission(actor.id, workspaceId, entityType, record);
      return true;
    } catch {
      return false;
    }
  }

  private assertNoDuplicateContactCommunications(workspaceId: string, communications: CommunicationInput[], forceCreate: boolean) {
    if (forceCreate) return;
    const duplicates = communications
      .map((communication) => ({
        ...communication,
        normalizedValue: normalizeCommunication(communication.type, communication.value),
      }))
      .filter((communication) => communication.type === 'EMAIL' || communication.type === 'PHONE')
      .flatMap((communication) =>
        this.store.state.crmContactCommunications
          .filter(
            (existing) =>
              existing.workspaceId === workspaceId &&
              existing.type === communication.type &&
              existing.normalizedValue === communication.normalizedValue,
          )
          .map((existing) => ({ contactId: existing.contactId, type: existing.type, value: existing.value })),
      );
    if (duplicates.length > 0) throw conflict('CRM_DUPLICATE_DETECTED', 'Potential duplicate contact detected.', { matches: duplicates });
  }

  private assertNoDuplicateCompanyCommunications(workspaceId: string, communications: CommunicationInput[], forceCreate: boolean) {
    if (forceCreate) return;
    const duplicates = communications
      .map((communication) => ({
        ...communication,
        normalizedValue: normalizeCommunication(communication.type, communication.value),
      }))
      .filter((communication) => communication.type === 'EMAIL' || communication.type === 'PHONE' || communication.type === 'WEB')
      .flatMap((communication) =>
        this.store.state.crmCompanyCommunications
          .filter(
            (existing) =>
              existing.workspaceId === workspaceId &&
              existing.type === communication.type &&
              existing.normalizedValue === communication.normalizedValue,
          )
          .map((existing) => ({ companyId: existing.companyId, type: existing.type, value: existing.value })),
      );
    if (duplicates.length > 0) throw conflict('CRM_DUPLICATE_DETECTED', 'Potential duplicate company detected.', { matches: duplicates });
  }

  private activeContact(workspaceId: string, contactId: string) {
    const contact = this.store.state.crmContacts.find((item) => item.id === contactId && item.workspaceId === workspaceId && !item.isDeleted);
    if (!contact) throw notFound('CRM_CONTACT');
    return contact;
  }

  private activeCompany(workspaceId: string, companyId: string) {
    const company = this.store.state.crmCompanies.find((item) => item.id === companyId && item.workspaceId === workspaceId && !item.isDeleted);
    if (!company) throw notFound('CRM_COMPANY');
    return company;
  }

  private activeLead(workspaceId: string, leadId: string) {
    const lead = this.store.state.crmLeads.find((item) => item.id === leadId && item.workspaceId === workspaceId && !item.isDeleted);
    if (!lead) throw notFound('CRM_LEAD');
    return lead;
  }

  private activeDeal(workspaceId: string, dealId: string) {
    const deal = this.store.state.crmDeals.find((item) => item.id === dealId && item.workspaceId === workspaceId && !item.isDeleted);
    if (!deal) throw notFound('CRM_DEAL');
    return deal;
  }

  private activeCrmRecord(workspaceId: string, entityType: CrmRecordEntityType, recordId: string): ResponsibleRecord {
    if (entityType === 'LEAD') return this.activeLead(workspaceId, recordId);
    if (entityType === 'DEAL') return this.activeDeal(workspaceId, recordId);
    if (entityType === 'CONTACT') return this.activeContact(workspaceId, recordId);
    return this.activeCompany(workspaceId, recordId);
  }

  private resolveConversionContact(
    actor: User,
    workspaceId: string,
    lead: CrmLead,
    input: LeadConversionInput['contact'],
  ) {
    if (input.action === 'NONE') return null;
    if (input.action === 'LINK_EXISTING') {
      if (!input.contactId) throw badRequest('CRM_CONVERSION_INVALID', 'Existing contact ID is required.');
      return this.activeContact(workspaceId, input.contactId);
    }
    const create = input.create ?? {};
    return this.createContact(actor, workspaceId, {
      firstName: create.firstName ?? lead.firstName ?? 'Lead',
      lastName: create.lastName ?? lead.lastName ?? 'Contact',
      communications: create.communications ?? this.store.state.crmLeadCommunications
        .filter((item) => item.leadId === lead.id)
        .map((item) => ({ type: item.type, value: item.value, label: item.label, isPrimary: item.isPrimary })),
      forceCreate: true,
      customFields: create.customFields,
    });
  }

  private resolveConversionCompany(
    actor: User,
    workspaceId: string,
    lead: CrmLead,
    input: LeadConversionInput['company'],
  ) {
    if (input.action === 'NONE') return null;
    if (input.action === 'LINK_EXISTING') {
      if (!input.companyId) throw badRequest('CRM_CONVERSION_INVALID', 'Existing company ID is required.');
      return this.activeCompany(workspaceId, input.companyId);
    }
    const create = input.create ?? {};
    return this.createCompany(actor, workspaceId, {
      name: create.name ?? lead.companyName ?? lead.title,
      communications: create.communications ?? [],
      forceCreate: true,
      customFields: create.customFields,
    });
  }

  private clearContactPrimaryCommunication(contactId: string, type: CrmCommunicationType) {
    for (const communication of this.store.state.crmContactCommunications) {
      if (communication.contactId === contactId && communication.type === type) {
        communication.isPrimary = false;
      }
    }
  }

  private clearCompanyPrimaryCommunication(companyId: string, type: CrmCommunicationType) {
    for (const communication of this.store.state.crmCompanyCommunications) {
      if (communication.companyId === companyId && communication.type === type) {
        communication.isPrimary = false;
      }
    }
  }

  private clearPrimaryContactCompany(contactId: string) {
    for (const relation of this.store.state.crmContactCompanies) {
      if (relation.contactId === contactId) {
        relation.isPrimary = false;
        relation.updatedAt = now();
      }
    }
  }

  private clearPrimaryDealContact(dealId: string) {
    for (const relation of this.store.state.crmDealContacts) {
      if (relation.dealId === dealId) {
        relation.isPrimary = false;
        relation.updatedAt = now();
      }
    }
  }

  private primaryContactCommunications(workspaceId: string, contactId: string) {
    return this.store.state.crmContactCommunications
      .filter((item) => item.workspaceId === workspaceId && item.contactId === contactId && item.isPrimary)
      .map(({ type, value, label }) => ({ type, value, label }));
  }

  private primaryCompanyCommunications(workspaceId: string, companyId: string) {
    return this.store.state.crmCompanyCommunications
      .filter((item) => item.workspaceId === workspaceId && item.companyId === companyId && item.isPrimary)
      .map(({ type, value, label }) => ({ type, value, label }));
  }

  private addressSummary(record: Pick<CrmContact | CrmCompany, 'addressLine1' | 'addressLine2' | 'city' | 'stateOrProvince' | 'postalCode' | 'countryCode'>) {
    return {
      addressLine1: record.addressLine1 ?? null,
      addressLine2: record.addressLine2 ?? null,
      city: record.city ?? null,
      stateOrProvince: record.stateOrProvince ?? null,
      postalCode: record.postalCode ?? null,
      countryCode: record.countryCode ?? null,
    };
  }

  private archiveRecord<T extends CrmContact | CrmCompany | CrmLead | CrmDeal>(
    actor: User,
    workspaceId: string,
    record: T,
    entityType: string,
    action: string,
  ) {
    this.assertMembership(actor.id, workspaceId);
    const before = { ...record };
    record.isArchived = true;
    record.archivedAt = now();
    record.archivedByUserId = actor.id;
    record.updatedAt = now();
    record.version += 1;
    this.audit(actor.id, workspaceId, action, entityType, record.id, before, record);
    return record;
  }

  private restoreArchivedRecord<T extends CrmContact | CrmCompany | CrmLead | CrmDeal>(
    actor: User,
    workspaceId: string,
    record: T,
    entityType: string,
    action: string,
  ) {
    this.assertMembership(actor.id, workspaceId);
    const before = { ...record };
    record.isArchived = false;
    record.archivedAt = null;
    record.archivedByUserId = null;
    record.updatedAt = now();
    record.version += 1;
    this.audit(actor.id, workspaceId, action, entityType, record.id, before, record);
    return record;
  }

  private softDeleteRecord<T extends CrmContact | CrmCompany | CrmLead | CrmDeal>(
    actor: User,
    workspaceId: string,
    record: T,
    entityType: string,
    action: string,
  ) {
    const before = { ...record };
    record.isDeleted = true;
    record.deletedAt = now();
    record.deletedByUserId = actor.id;
    record.isArchived = false;
    record.archivedAt = null;
    record.archivedByUserId = null;
    record.updatedAt = now();
    record.version += 1;
    this.audit(actor.id, workspaceId, action, entityType, record.id, before, record);
    return record;
  }

  private restoreDeletedRecord<T extends CrmContact | CrmCompany | CrmLead | CrmDeal>(
    actor: User,
    workspaceId: string,
    record: T,
    entityType: string,
    action: string,
  ) {
    this.assertMembership(actor.id, workspaceId);
    const before = { ...record };
    record.isDeleted = false;
    record.deletedAt = null;
    record.deletedByUserId = null;
    record.updatedAt = now();
    record.version += 1;
    this.audit(actor.id, workspaceId, action, entityType, record.id, before, record);
    return record;
  }

  private assertMembership(userId: string, workspaceId: string) {
    const workspace = this.store.state.workspaces.find((item) => item.id === workspaceId && !item.isDeleted);
    if (!workspace) throw notFound('Workspace');
    const membership = this.store.state.workspaceMemberships.find(
      (item) => item.userId === userId && item.workspaceId === workspaceId && item.status === 'ACTIVE' && !item.isDeleted,
    );
    if (!membership) throw forbidden('Workspace membership is required.');
    const role = this.store.state.roles.find((item) => item.id === membership.roleId && !item.isDeleted);
    if (!role) throw forbidden('Workspace role is required.');
    return { workspace, membership, role };
  }

  private assertActiveWorkspaceMember(workspaceId: string, userId: string) {
    const membership = this.store.state.workspaceMemberships.find(
      (item) => item.workspaceId === workspaceId && item.userId === userId && item.status === 'ACTIVE' && !item.isDeleted,
    );
    if (!membership) throw notFound('Workspace member');
    return membership;
  }

  private assertReadPermission(userId: string, workspaceId: string, entityType: CrmRecordEntityType, record: ResponsibleRecord) {
    const scope = this.permissionScope(userId, workspaceId, this.permissionKey(entityType, 'read'));
    if (this.scopeAllows(scope, userId, record)) return;
    if (
      this.store.state.crmRecordObservers.some(
        (observer) =>
          observer.workspaceId === workspaceId &&
          observer.entityType === entityType &&
          observer.recordId === record.id &&
          observer.userId === userId,
      )
    ) {
      return;
    }
    throw forbidden();
  }

  private assertRecordPermission(userId: string, workspaceId: string, permissionKey: string, record: ResponsibleRecord) {
    const scope = this.permissionScope(userId, workspaceId, permissionKey);
    if (!this.scopeAllows(scope, userId, record)) throw forbidden();
  }

  private permissionScope(userId: string, workspaceId: string, permissionKey: string): PermissionScope {
    const { role } = this.assertMembership(userId, workspaceId);
    if (role.isOwnerRole) return 'WORKSPACE';
    const rolePermission = this.store.state.rolePermissions.find((item) => {
      const permission = this.store.state.permissions.find((candidate) => candidate.id === item.permissionId);
      return item.roleId === role.id && !item.isDeleted && permission?.key === permissionKey;
    });
    if (!rolePermission) throw forbidden();
    return rolePermission.scope;
  }

  private scopeAllows(scope: PermissionScope, userId: string, record: ResponsibleRecord) {
    if (scope === 'WORKSPACE') return true;
    if (scope === 'OWN') return record.responsibleUserId === userId;
    return false;
  }

  private permissionKey(entityType: CrmRecordEntityType, action: 'read' | 'update' | 'assign') {
    const resource = entityType === 'COMPANY' ? 'company' : entityType.toLowerCase();
    return `crm.${resource}.${action}`;
  }

  private entityClass(entityType: CrmRecordEntityType) {
    if (entityType === 'LEAD') return 'CrmLead';
    if (entityType === 'DEAL') return 'CrmDeal';
    if (entityType === 'CONTACT') return 'CrmContact';
    return 'CrmCompany';
  }

  private audit(actorUserId: string, workspaceId: string, action: string, entityType: string, entityId: string, beforeData: unknown, afterData: unknown) {
    new AuditService(this.store).write({
      workspaceId,
      actorUserId,
      action,
      entityType,
      entityId,
      beforeData,
      afterData,
    });
  }

  private findIdempotentReplay(
    workspaceId: string,
    actorUserId: string,
    operation: string,
    input: unknown,
    idempotencyKey?: string,
  ) {
    if (!idempotencyKey) return null;
    const requestHash = JSON.stringify(input);
    const existing = this.store.state.idempotencyRecords.find(
      (item) =>
        item.workspaceId === workspaceId &&
        item.actorUserId === actorUserId &&
        item.operation === operation &&
        item.idempotencyKey === idempotencyKey &&
        item.expiresAt > now(),
    );
    if (!existing) return null;
    if (existing.requestHash !== requestHash) {
      throw conflict('IDEMPOTENCY_KEY_REUSED', 'Idempotency key was reused with a different payload.');
    }
    return existing.response;
  }

  private storeIdempotentResponse(
    workspaceId: string,
    actorUserId: string,
    operation: string,
    input: unknown,
    idempotencyKey: string | undefined,
    response: Record<string, unknown>,
  ) {
    if (!idempotencyKey) return;
    this.store.state.idempotencyRecords.push({
      id: this.store.id(),
      workspaceId,
      actorUserId,
      operation,
      idempotencyKey,
      requestHash: JSON.stringify(input),
      response,
      expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
      createdAt: now(),
    });
  }
}
