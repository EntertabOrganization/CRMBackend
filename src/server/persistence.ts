import type { Prisma, PrismaClient } from '@prisma/client';
import { canonicalDecimal } from './fields/decimal';
import type { DbState } from './store';

type Delegate = {
  findMany: (args?: unknown) => Promise<unknown[]>;
  upsert: (args: { where: { id: string }; create: unknown; update: unknown }) => Promise<unknown>;
  deleteMany: (args: { where: { id: { in: string[] } } }) => Promise<unknown>;
};

type TxClient = PrismaClient | Prisma.TransactionClient;
type RowWithJson = {
  settings?: unknown;
  meta?: unknown;
  payload?: unknown;
  response?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

function asRecordOrNull(value: unknown): Record<string, unknown> | null {
  return value == null ? null : (value as Record<string, unknown>);
}

// Parent-to-child order, safe for upserts. Deletes run in the reverse order.
const COLLECTIONS: { key: keyof DbState; delegate: (client: TxClient) => Delegate }[] = [
  { key: 'permissions', delegate: (c) => c.permission as unknown as Delegate },
  { key: 'partnerRoles', delegate: (c) => c.partnerRole as unknown as Delegate },
  { key: 'partners', delegate: (c) => c.partner as unknown as Delegate },
  { key: 'users', delegate: (c) => c.user as unknown as Delegate },
  { key: 'authIdentities', delegate: (c) => c.authIdentity as unknown as Delegate },
  { key: 'refreshSessions', delegate: (c) => c.refreshSession as unknown as Delegate },
  { key: 'emailVerificationTokens', delegate: (c) => c.emailVerificationToken as unknown as Delegate },
  { key: 'passwordResetTokens', delegate: (c) => c.passwordResetToken as unknown as Delegate },
  { key: 'workspaces', delegate: (c) => c.workspace as unknown as Delegate },
  { key: 'roles', delegate: (c) => c.role as unknown as Delegate },
  { key: 'rolePermissions', delegate: (c) => c.rolePermission as unknown as Delegate },
  { key: 'workspaceMemberships', delegate: (c) => c.workspaceMembership as unknown as Delegate },
  { key: 'workspaceInvitations', delegate: (c) => c.workspaceInvitation as unknown as Delegate },
  { key: 'departments', delegate: (c) => c.department as unknown as Delegate },
  { key: 'departmentMembers', delegate: (c) => c.departmentMember as unknown as Delegate },
  { key: 'partnerMemberships', delegate: (c) => c.partnerMembership as unknown as Delegate },
  { key: 'partnerWorkspaceRelations', delegate: (c) => c.partnerWorkspaceRelation as unknown as Delegate },
  { key: 'partnerApplications', delegate: (c) => c.partnerApplication as unknown as Delegate },
  { key: 'auditLogs', delegate: (c) => c.auditLog as unknown as Delegate },
  { key: 'crmPipelines', delegate: (c) => c.crmPipeline as unknown as Delegate },
  { key: 'crmStages', delegate: (c) => c.crmStage as unknown as Delegate },
  { key: 'crmStageTransitions', delegate: (c) => c.crmStageTransition as unknown as Delegate },
  { key: 'crmRoleStagePermissions', delegate: (c) => c.crmRoleStagePermission as unknown as Delegate },
  { key: 'crmLostReasons', delegate: (c) => c.crmLostReason as unknown as Delegate },
  { key: 'crmContacts', delegate: (c) => c.crmContact as unknown as Delegate },
  { key: 'crmCompanies', delegate: (c) => c.crmCompany as unknown as Delegate },
  { key: 'crmSources', delegate: (c) => c.crmSource as unknown as Delegate },
  { key: 'crmLeadCommunications', delegate: (c) => c.crmLeadCommunication as unknown as Delegate },
  { key: 'crmContactCommunications', delegate: (c) => c.crmContactCommunication as unknown as Delegate },
  { key: 'crmCompanyCommunications', delegate: (c) => c.crmCompanyCommunication as unknown as Delegate },
  { key: 'crmLeadContacts', delegate: (c) => c.crmLeadContact as unknown as Delegate },
  { key: 'crmContactCompanies', delegate: (c) => c.crmContactCompany as unknown as Delegate },
  { key: 'crmLeads', delegate: (c) => c.crmLead as unknown as Delegate },
  { key: 'crmDeals', delegate: (c) => c.crmDeal as unknown as Delegate },
  { key: 'crmDealContacts', delegate: (c) => c.crmDealContact as unknown as Delegate },
  { key: 'crmLeadConversions', delegate: (c) => c.crmLeadConversion as unknown as Delegate },
  { key: 'crmRecordObservers', delegate: (c) => c.crmRecordObserver as unknown as Delegate },
  { key: 'crmStageHistory', delegate: (c) => c.crmStageHistory as unknown as Delegate },
  { key: 'outboxEvents', delegate: (c) => c.outboxEvent as unknown as Delegate },
  { key: 'idempotencyRecords', delegate: (c) => c.idempotencyRecord as unknown as Delegate },
  { key: 'crmCustomFields', delegate: (c) => c.crmCustomField as unknown as Delegate },
  { key: 'crmCustomFieldOptions', delegate: (c) => c.crmCustomFieldOption as unknown as Delegate },
  { key: 'crmCustomFieldValues', delegate: (c) => c.crmCustomFieldValue as unknown as Delegate },
  { key: 'crmFieldVisibilityRules', delegate: (c) => c.crmFieldVisibilityRule as unknown as Delegate },
  { key: 'crmFieldRequirements', delegate: (c) => c.crmFieldRequirement as unknown as Delegate },
  { key: 'crmCustomFieldMigrations', delegate: (c) => c.crmCustomFieldMigration as unknown as Delegate },
  { key: 'crmFieldSchemaVersions', delegate: (c) => c.crmFieldSchemaVersion as unknown as Delegate },
  { key: 'crmActivityTypes', delegate: (c) => c.crmActivityType as unknown as Delegate },
  { key: 'crmActivities', delegate: (c) => c.crmActivity as unknown as Delegate },
  { key: 'crmActivityBindings', delegate: (c) => c.crmActivityBinding as unknown as Delegate },
  { key: 'crmActivityParticipants', delegate: (c) => c.crmActivityParticipant as unknown as Delegate },
  { key: 'crmActivityCommunications', delegate: (c) => c.crmActivityCommunication as unknown as Delegate },
  { key: 'crmActivityReminders', delegate: (c) => c.crmActivityReminder as unknown as Delegate },
  { key: 'crmActivityReminderRecipients', delegate: (c) => c.crmActivityReminderRecipient as unknown as Delegate },
  { key: 'crmActivityOverdueOccurrences', delegate: (c) => c.crmActivityOverdueOccurrence as unknown as Delegate },
  { key: 'crmTimelineEntries', delegate: (c) => c.crmTimelineEntry as unknown as Delegate },
  { key: 'crmTimelineComments', delegate: (c) => c.crmTimelineComment as unknown as Delegate },
  { key: 'crmTimelineCommentMentions', delegate: (c) => c.crmTimelineCommentMention as unknown as Delegate },
];

/**
 * Collections added by the Automation and Products & Catalog modules. They are table-driven: `model` is the Prisma delegate
 * name and `decimals` lists NUMERIC columns that Prisma returns as Decimal instances (the domain works with canonical decimal
 * strings, so hydration converts them and persistence hands the strings straight back to Prisma).
 */
type ExtraCollection = { key: keyof DbState; model: string; decimals?: string[] };
const EXTRA_COLLECTIONS: ExtraCollection[] = [
  { key: 'catalogSettings', model: 'catalogSettings' },
  { key: 'catalogs', model: 'catalog' },
  { key: 'catalogUnits', model: 'catalogUnit' },
  { key: 'catalogPriceTypes', model: 'catalogPriceType' },
  { key: 'catalogCategories', model: 'catalogCategory' },
  { key: 'catalogProducts', model: 'catalogProduct', decimals: ['taxRate', 'weight', 'length', 'width', 'height'] },
  { key: 'catalogProductCategories', model: 'catalogProductCategory' },
  { key: 'catalogUnitRatios', model: 'catalogProductUnitRatio', decimals: ['ratio'] },
  { key: 'catalogPrices', model: 'catalogProductPrice', decimals: ['amount'] },
  { key: 'catalogPropertyProfiles', model: 'catalogPropertyProfile' },
  { key: 'catalogProductMedia', model: 'catalogProductMedia' },
  { key: 'commercialRowSets', model: 'commercialRowSet', decimals: ['subtotal', 'taxTotal', 'total'] },
  {
    key: 'commercialProductRows',
    model: 'commercialProductRow',
    decimals: ['unitRatioSnapshot', 'quantity', 'unitPrice', 'discountValue', 'discountAmount', 'taxRate', 'subtotal', 'taxAmount', 'total'],
  },
  { key: 'automationRules', model: 'automationRule' },
  { key: 'automationRevisions', model: 'automationRuleRevision' },
  { key: 'automationActions', model: 'automationAction' },
  { key: 'automationJobs', model: 'automationJob' },
  { key: 'automationExecutions', model: 'automationExecution' },
  { key: 'automationActionExecutions', model: 'automationActionExecution' },
  { key: 'automationLogs', model: 'automationLog' },
  { key: 'automationExtensions', model: 'automationExtensionDefinition' },
  { key: 'automationCredentials', model: 'automationIntegrationCredential' },
];

const PACK_COLLECTIONS: Array<keyof DbState> = [
  'requisitePresets','requisites','requisiteAddresses','bankAccounts','sellerCompanyBindings','commercialSnapshots','estimateStages',
  'estimates','invoices','invoiceSequences','payments','paymentAllocations','paymentAttempts','paymentProviderEvents','refunds',
  'recurringRules','recurringOccurrences','crmForms','crmFormVersions','crmFormSubmissions','crmFormEntityBindings','crmFormUploads',
  'communicationChannels','channelConnections','contactCenterQueues','contactCenterQueueMembers','customerChannelIdentities',
  'customerConversations','conversationMessages','conversationAssignments','conversationTransfers','channelProviderEvents','slaPolicies','slaTimers','backgroundJobs',
];
for (const extra of EXTRA_COLLECTIONS) {
  COLLECTIONS.push({ key: extra.key, delegate: (c) => (c as unknown as Record<string, Delegate>)[extra.model] });
}

/**
 * Collections whose rows carry a natural UNIQUE key and are replaced by delete + re-insert under a new id (typed custom values,
 * participants, mentions, timeline rebuilds...). They have no foreign keys, so their removals run BEFORE the upserts; otherwise the
 * re-inserted row would collide with the row it replaces.
 */
const DELETE_BEFORE_UPSERT = new Set<keyof DbState>([
  'crmCustomFieldValues',
  'crmCustomFieldOptions',
  'crmFieldVisibilityRules',
  'crmActivityBindings',
  'crmActivityParticipants',
  'crmActivityReminders',
  'crmActivityReminderRecipients',
  'crmActivityOverdueOccurrences',
  'crmTimelineEntries',
  'crmTimelineCommentMentions',
  // Draft action lists are rebuilt on every edit under the (revision, sortOrder) unique key.
  'automationActions',
]);

export async function hydrateState(client: PrismaClient): Promise<DbState> {
  const [
    users,
    authIdentities,
    refreshSessions,
    emailVerificationTokens,
    passwordResetTokens,
    workspaces,
    workspaceMemberships,
    workspaceInvitations,
    permissions,
    roles,
    rolePermissions,
    departments,
    departmentMembers,
    partnerApplications,
    partners,
    partnerRoles,
    partnerMemberships,
    partnerWorkspaceRelations,
    auditLogs,
    crmPipelines,
    crmStages,
    crmStageTransitions,
    crmRoleStagePermissions,
    crmLostReasons,
    crmContacts,
    crmCompanies,
    crmSources,
    crmLeadCommunications,
    crmContactCommunications,
    crmCompanyCommunications,
    crmLeadContacts,
    crmContactCompanies,
    crmLeads,
    crmDeals,
    crmDealContacts,
    crmLeadConversions,
    crmRecordObservers,
    crmStageHistory,
    outboxEvents,
    idempotencyRecords,
    crmCustomFields,
    crmCustomFieldOptions,
    crmCustomFieldValues,
    crmFieldVisibilityRules,
    crmFieldRequirements,
    crmCustomFieldMigrations,
    crmFieldSchemaVersions,
    crmActivityTypes,
    crmActivities,
    crmActivityBindings,
    crmActivityParticipants,
    crmActivityCommunications,
    crmActivityReminders,
    crmActivityReminderRecipients,
    crmActivityOverdueOccurrences,
    crmTimelineEntries,
    crmTimelineComments,
    crmTimelineCommentMentions,
  ] = await Promise.all([
    client.user.findMany(),
    client.authIdentity.findMany(),
    client.refreshSession.findMany(),
    client.emailVerificationToken.findMany(),
    client.passwordResetToken.findMany(),
    client.workspace.findMany(),
    client.workspaceMembership.findMany(),
    client.workspaceInvitation.findMany(),
    client.permission.findMany(),
    client.role.findMany(),
    client.rolePermission.findMany(),
    client.department.findMany(),
    client.departmentMember.findMany(),
    client.partnerApplication.findMany(),
    client.partner.findMany(),
    client.partnerRole.findMany(),
    client.partnerMembership.findMany(),
    client.partnerWorkspaceRelation.findMany(),
    client.auditLog.findMany(),
    client.crmPipeline.findMany(),
    client.crmStage.findMany(),
    client.crmStageTransition.findMany(),
    client.crmRoleStagePermission.findMany(),
    client.crmLostReason.findMany(),
    client.crmContact.findMany(),
    client.crmCompany.findMany(),
    client.crmSource.findMany(),
    client.crmLeadCommunication.findMany(),
    client.crmContactCommunication.findMany(),
    client.crmCompanyCommunication.findMany(),
    client.crmLeadContact.findMany(),
    client.crmContactCompany.findMany(),
    client.crmLead.findMany(),
    client.crmDeal.findMany(),
    client.crmDealContact.findMany(),
    client.crmLeadConversion.findMany(),
    client.crmRecordObserver.findMany(),
    client.crmStageHistory.findMany(),
    client.outboxEvent.findMany(),
    client.idempotencyRecord.findMany(),
    client.crmCustomField.findMany(),
    client.crmCustomFieldOption.findMany(),
    client.crmCustomFieldValue.findMany(),
    client.crmFieldVisibilityRule.findMany(),
    client.crmFieldRequirement.findMany(),
    client.crmCustomFieldMigration.findMany(),
    client.crmFieldSchemaVersion.findMany(),
    client.crmActivityType.findMany(),
    client.crmActivity.findMany(),
    client.crmActivityBinding.findMany(),
    client.crmActivityParticipant.findMany(),
    client.crmActivityCommunication.findMany(),
    client.crmActivityReminder.findMany(),
    client.crmActivityReminderRecipient.findMany(),
    client.crmActivityOverdueOccurrence.findMany(),
    client.crmTimelineEntry.findMany(),
    client.crmTimelineComment.findMany(),
    client.crmTimelineCommentMention.findMany(),
  ]);

  const state = {
    users: users.map((row: RowWithJson) => ({ ...row, settings: asRecord(row.settings), meta: asRecordOrNull(row.meta) })),
    authIdentities,
    refreshSessions,
    emailVerificationTokens,
    passwordResetTokens,
    workspaces: workspaces.map((row: RowWithJson) => ({ ...row, settings: asRecord(row.settings), meta: asRecordOrNull(row.meta) })),
    workspaceMemberships,
    workspaceInvitations,
    permissions,
    roles,
    rolePermissions,
    departments,
    departmentMembers,
    partnerApplications,
    partners: partners.map((row: RowWithJson) => ({ ...row, settings: asRecord(row.settings), meta: asRecordOrNull(row.meta) })),
    partnerRoles,
    partnerMemberships,
    partnerWorkspaceRelations,
    auditLogs,
    crmPipelines,
    crmStages,
    crmStageTransitions,
    crmRoleStagePermissions,
    crmLostReasons,
    crmContacts,
    crmCompanies,
    crmSources,
    crmLeadCommunications,
    crmContactCommunications,
    crmCompanyCommunications,
    crmLeadContacts,
    crmContactCompanies,
    crmLeads,
    crmDeals,
    crmDealContacts,
    crmLeadConversions,
    crmRecordObservers,
    crmStageHistory,
    outboxEvents: outboxEvents.map((row: RowWithJson) => ({ ...row, payload: asRecord(row.payload) })),
    idempotencyRecords: idempotencyRecords.map((row: RowWithJson) => ({ ...row, response: asRecord(row.response) })),
    crmCustomFields,
    crmCustomFieldOptions,
    // Prisma returns Decimal instances; the domain works with canonical decimal strings.
    crmCustomFieldValues: crmCustomFieldValues.map((row: { valueDecimal?: { toFixed(): string } | null }) => ({
      ...row,
      valueDecimal: row.valueDecimal == null ? null : canonicalDecimal(row.valueDecimal.toFixed()),
    })),
    crmFieldVisibilityRules,
    crmFieldRequirements,
    crmCustomFieldMigrations,
    crmFieldSchemaVersions,
    crmActivityTypes,
    crmActivities: crmActivities.map((row: { fileIds?: unknown }) => ({ ...row, fileIds: Array.isArray(row.fileIds) ? row.fileIds : [] })),
    crmActivityBindings,
    crmActivityParticipants,
    crmActivityCommunications,
    crmActivityReminders,
    crmActivityReminderRecipients,
    crmActivityOverdueOccurrences,
    crmTimelineEntries: crmTimelineEntries.map((row: { presentationSnapshot?: unknown }) => ({ ...row, presentationSnapshot: asRecord(row.presentationSnapshot) })),
    crmTimelineComments: crmTimelineComments.map((row: { fileIds?: unknown }) => ({ ...row, fileIds: Array.isArray(row.fileIds) ? row.fileIds : [] })),
    crmTimelineCommentMentions,
  } as unknown as DbState;

  const target = state as unknown as Record<string, unknown[]>;
  const extraRows = await Promise.all(
    EXTRA_COLLECTIONS.map((extra) => (client as unknown as Record<string, Delegate>)[extra.model].findMany() as Promise<Array<Record<string, unknown>>>),
  );
  EXTRA_COLLECTIONS.forEach((extra, index) => {
    const rows = extraRows[index];
    target[extra.key as string] = extra.decimals?.length ? rows.map((row) => decimalsToStrings(row, extra.decimals!)) : rows;
  });
  const packed = await (client.commercialPackRecord as unknown as Delegate).findMany() as Array<{ collection:string; data:unknown }>;
  for (const key of PACK_COLLECTIONS) target[key as string] = [];
  for (const record of packed) {
    if (PACK_COLLECTIONS.includes(record.collection as keyof DbState)) target[record.collection].push(reviveDates(record.data));
  }
  return state;
}

function reviveDates(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map((item) => reviveDates(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string,unknown>).map(([k,v])=>[k,reviveDates(v,k)]));
  if (typeof value === 'string' && /(At|Until|ExpiresAt|RunAt)$/.test(key) && /^\d{4}-\d{2}-\d{2}T/.test(value)) return new Date(value);
  return value;
}

/** Prisma returns Decimal instances; the domain carries canonical decimal strings. */
function decimalsToStrings(row: Record<string, unknown>, columns: string[]) {
  const copy = { ...row };
  for (const column of columns) {
    const value = copy[column] as { toFixed(): string } | null | undefined;
    copy[column] = value == null ? null : canonicalDecimal(value.toFixed());
  }
  return copy;
}

export async function persistState(client: PrismaClient, before: DbState, after: DbState): Promise<void> {
  await client.$transaction(
    async (tx: Prisma.TransactionClient) => {
      // Upserts run before deletes: a request can both remove a parent (e.g. hard-delete
      // a workspace) and write a new row that references it (e.g. the audit log entry
      // for that very deletion). Writing first lets the FK check succeed while the
      // parent still exists; the delete phase then relies on the schema's ON DELETE
      // behavior (cascade/set-null) for anything that still points at the removed row.
      for (const { key, delegate } of COLLECTIONS) {
        if (!DELETE_BEFORE_UPSERT.has(key)) continue;
        const afterIds = new Set((after[key] as unknown as { id: string }[]).map((row) => row.id));
        const removedIds = (before[key] as unknown as { id: string }[]).filter((row) => !afterIds.has(row.id)).map((row) => row.id);
        if (removedIds.length > 0) await delegate(tx).deleteMany({ where: { id: { in: removedIds } } });
      }

      for (const { key, delegate } of COLLECTIONS) {
        const beforeById = new Map(
          (before[key] as unknown as { id: string }[]).map((row) => [row.id, row]),
        );
        const rows = after[key] as unknown as { id: string }[];
        const changed = rows.filter((row) => {
          const previous = beforeById.get(row.id);
          return !previous || JSON.stringify(previous) !== JSON.stringify(row);
        });
        if (changed.length === 0) continue;
        const d = delegate(tx);
        for (const row of changed) {
          await d.upsert({ where: { id: row.id }, create: row, update: row });
        }
      }

      for (const { key, delegate } of [...COLLECTIONS].reverse()) {
        if (DELETE_BEFORE_UPSERT.has(key)) continue;
        const beforeRows = before[key] as unknown as { id: string }[];
        const afterIds = new Set((after[key] as unknown as { id: string }[]).map((row) => row.id));
        const removedIds = beforeRows.filter((row) => !afterIds.has(row.id)).map((row) => row.id);
        if (removedIds.length > 0) {
          await delegate(tx).deleteMany({ where: { id: { in: removedIds } } });
        }
      }

      const packDelegate = tx.commercialPackRecord;
      for (const key of PACK_COLLECTIONS) {
        const beforeById = new Map((before[key] as unknown as Array<{id:string}>).map(row=>[row.id,row]));
        const afterRows = after[key] as unknown as Array<{id:string;workspaceId?:string|null}>;
        for (const row of afterRows) {
          if (!beforeById.has(row.id) || JSON.stringify(beforeById.get(row.id)) !== JSON.stringify(row)) {
            const data = JSON.parse(JSON.stringify(row)) as Prisma.InputJsonValue;
            await packDelegate.upsert({ where:{id:row.id}, create:{id:row.id,workspaceId:row.workspaceId??null,collection:String(key),data}, update:{workspaceId:row.workspaceId??null,collection:String(key),data} });
          }
        }
        const afterIds=new Set(afterRows.map(row=>row.id));
        const removed=(before[key] as unknown as Array<{id:string}>).filter(row=>!afterIds.has(row.id)).map(row=>row.id);
        if(removed.length)await packDelegate.deleteMany({where:{id:{in:removed}}});
      }
    },
    { maxWait: 10_000, timeout: 30_000 },
  );
}
