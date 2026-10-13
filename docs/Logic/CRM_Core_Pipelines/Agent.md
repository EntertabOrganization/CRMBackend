# TrueCRM CRM Core + Pipelines — Agent Execution Contract

## Purpose

This file is the operating contract for any AI coding agent implementing **Module 03 — CRM Core Records** and **Module 04 — Pipelines & Stages** in TrueCRM.

The human partner should be able to give a goal such as:

```text
Complete CRM Core
Complete Leads
Complete Contacts
Complete CRM Companies
Complete Deals
Complete Lead Conversion
Complete Pipelines
Complete Stages
Complete CRM Core + Pipelines
```

The agent must inspect the real repository, read the relevant specifications in this pack, implement the requested goal completely, adapt/wire the executable contract tests, run them, repair failures, run the full regression suite, and only then report the requested scope as finished.

Do not stop merely to present a plan. Continue automatically unless a genuine blocker requires a human decision, unavailable credential, unavailable external module, or an unresolvable conflict with a locked business rule.

---

## 1. Authority and precedence

For Modules 03 and 04, use this order of authority:

1. security and tenant-isolation non-negotiables
2. locked decisions in this CRM Core + Pipelines pack
3. existing repository architecture and conventions
4. current TrueCRM System Architecture / PRD / BRD
5. Bitrix24 behavior as a reference pattern only

Bitrix24 is **not** an implementation authority. This pack deliberately differs from Bitrix24 in places, especially by supporting multiple Lead pipelines.

If the repository convention differs only in implementation detail, adapt this specification to the repository while preserving behavior.

If a conflict would change a locked business/security decision, stop and report the exact conflict rather than silently choosing one side.

---

## 2. Non-negotiable architecture

### Technology direction

- NestJS modular monolith.
- PostgreSQL is the business source of truth.
- Prisma is the ORM/data-access layer unless the repository proves otherwise.
- Reuse existing repository conventions before adding dependencies or abstractions.
- Workspace is the tenant boundary.
- Every business record, configuration record and relationship must be scoped to one Workspace directly or through a strongly validated parent.
- One active WorkspaceMembership has exactly one Workspace Role.
- Backend authorization is authoritative.
- Never trust a client-supplied Workspace identifier without resolving active membership and authorization.
- CRM Company is a customer/business record and is **never** the Workspace tenant.
- AuditLog is centralized and append-only.
- Domain transaction + outbox + critical audit evidence must be committed consistently.

### Domain ownership

**CRM Core owns:**

- Lead
- Contact
- CRM Company
- Deal
- direct CRM relationships
- normalized CRM communications
- CRM source selection/reference
- Lead conversion
- CRM lifecycle state
- responsibility and observer bindings
- ordinary CRM addresses
- raw UTM/origin metadata required to preserve acquisition context

**Pipelines & Stages owns:**

- Lead and Deal pipelines
- stages and semantic state
- default pipeline/stage configuration
- stage transitions
- cross-pipeline movement validation
- lost reasons
- stage history
- configuration migration/deactivation
- stage permission integration
- required-field integration boundary

**Not owned here:**

- Activities/Timeline
- Products/Catalog
- Forms
- Files/Documents
- Payments
- Automation runtime
- Custom-field definitions/values engine
- Data Quality merge engine
- Sales Intelligence attribution engine
- Search index
- Analytics facts/materialized views

This pack defines integration boundaries for those modules but must not secretly implement them inside CRM Core.

---

## 3. Naming and persistence conventions

- TypeScript/Prisma fields: `camelCase`.
- PostgreSQL tables/columns: `snake_case` through Prisma mapping where that matches repository style.
- Primary keys: UUID.
- Stable entity IDs must never be regenerated merely because a record is renamed/reordered.
- Common CRM entities may use `createdAt`, `updatedAt`, and `version` because these are functional for CRM ordering/concurrency/history.
- Archive/delete metadata is functional lifecycle state and is required where specified.
- Never store raw secrets/tokens in CRM records, audit payloads, idempotency rows or outbox payloads.

Recommended table families, subject to repository conventions while preserving behavior:

```text
crm_leads
crm_lead_communications
crm_lead_conversions
crm_contacts
crm_contact_communications
crm_companies
crm_company_communications
crm_contact_companies
crm_deals
crm_deal_contacts
crm_record_observers
crm_sources
crm_lost_reasons
crm_pipelines
crm_stages
crm_stage_transitions
crm_lead_stage_history
crm_deal_stage_history
```

Do not add generic polymorphic relationship tables where a strong existing relational model already exists, except where this specification explicitly accepts a cross-entity abstraction such as record observers.

---

## 4. Core entity meanings

- **Lead** = unqualified/new sales inquiry or prospect. It can also represent a new inquiry from an existing customer.
- **Contact** = a real person/customer/contact record.
- **CRM Company** = a customer/business/account organization.
- **Deal** = a commercial/sales opportunity. A Deal is never the customer identity itself.

There is no separate `Customer` table in this scope.

A Contact may relate to several CRM Companies.
A CRM Company may relate to several Contacts.
A Contact/Company may participate in many Deals.

Every Lead, Contact, CRM Company and Deal has exactly one current `responsibleUserId`.

---

## 5. Pipeline model

Both **LEAD** and **DEAL** use the same reusable pipeline engine.

Recommended pipeline discriminator:

```text
LEAD
DEAL
```

Rules:

- a LEAD pipeline can contain only Leads
- a DEAL pipeline can contain only Deals
- each record has exactly one current pipeline and one current stage
- every active Workspace has exactly one default active LEAD pipeline
- every active Workspace has exactly one default active DEAL pipeline
- each active pipeline has exactly one default stage
- the default stage must have semantic type `PROGRESS`
- pipeline names are case-insensitively unique within `(workspaceId, entityType)`
- the same visible name may exist once for LEAD and once for DEAL

Default bootstrap:

```text
Default Lead Pipeline
- New            PROGRESS / DEFAULT
- Qualified      SUCCESS
- Disqualified   FAILURE

Default Deal Pipeline
- New            PROGRESS / DEFAULT
- Won            SUCCESS
- Lost           FAILURE
```

Every active pipeline must contain:

- one or more `PROGRESS` stages
- exactly one `SUCCESS` stage
- one or more `FAILURE` stages

A stage has a stable UUID. Rename/reorder never changes its ID.

---

## 6. Stage semantics

Semantic values:

```text
PROGRESS
SUCCESS
FAILURE
```

For Deals:

```text
PROGRESS -> OPEN
SUCCESS  -> WON/CLOSED
FAILURE  -> LOST/CLOSED
```

For Leads:

```text
PROGRESS -> ACTIVE/OPEN
SUCCESS  -> QUALIFIED/SUCCESSFULLY CLOSED
FAILURE  -> DISQUALIFIED/UNSUCCESSFULLY CLOSED
```

Entering a Lead SUCCESS stage **does not automatically convert the Lead**.

Lead conversion is a separate explicit command.

If a record later moves from SUCCESS/FAILURE back to PROGRESS, current closure state is reopened while historical stage/closure information remains traceable.

---

## 7. CRM customer relationships

### Contact ↔ CRM Company

Many-to-many.

Relationship supports at minimum:

- Contact ID
- Company ID
- relationship-specific job title
- relationship-specific department
- `isPrimary`
- sort/order if the repository uses relationship ordering

If a Contact has Company relationships, at most one is primary.

Removing the current primary Company while other Company relationships remain requires an explicit replacement primary Company. The backend must not silently choose one by sort order.

### Deal ↔ customer

A Deal must have at least one customer identity:

```text
companyId != null
OR
at least one linked Contact
```

A Deal may have both:

```text
Company: Vodafone
Primary Contact: John
Other Contacts: Sarah, Ahmed
```

A Deal may link multiple Contacts. If Contacts exist, exactly one is primary.

Deal-contact relationships may carry a relationship role/label where supported by repository conventions, e.g. Decision Maker, Finance, Technical Contact.

Removing the current primary Deal Contact while other Contacts remain requires an explicit replacement primary Contact.

### Lead ↔ existing customer

A Lead may link to an existing CRM Company and/or existing Contacts before conversion. This allows a returning-customer inquiry to remain a Lead until explicitly converted.

All relationships must be same-Workspace. Cross-Workspace relationships are rejected.

---

## 8. Communications

Normalize communications rather than storing only one phone/email directly on CRM entities.

Support for Lead, Contact and CRM Company:

```text
PHONE
EMAIL
WEB
IM
```

A record may have multiple values of each type.

At most one communication is primary per `(entity, communicationType)`.

Recommended attributes:

- id
- workspaceId
- parent entity ID
- type
- value
- label/type code such as WORK, PERSONAL, MOBILE, OTHER where applicable
- isPrimary
- createdAt
- updatedAt

Do not implement message/conversation history here. WhatsApp/Telegram/etc. conversations belong to Communication/Contact Center. CRM Core stores contact identity/channel details only.

---

## 9. Responsible user and observers

### Responsible user

Every Lead, Contact, CRM Company and Deal has one current `responsibleUserId`.

If omitted on create:

```text
responsibleUserId = authenticated user
```

unless a trusted integration/service path explicitly assigns another eligible user and passes authorization.

Changing responsible user requires the entity-specific `assign` permission.

New responsible user must:

- belong to the same Workspace
- have active WorkspaceMembership
- be eligible for CRM responsibility under repository rules

Responsibility changes do not rewrite historical responsibility evidence.

A Workspace member owning CRM records cannot be removed/deactivated without explicit bulk reassignment or a supplied replacement responsible user. Never silently assign records to the Workspace owner.

### OWN scope

`OWN` means only:

```text
record.responsibleUserId == currentUser.id
```

Creation, previous ownership, being a linked Contact, or appearing in history does not make the record OWN.

### Observers

CRM Core supports observers/followers.

Observer behavior:

- observer does not become responsible
- observer receives read access to that specific record
- observer does not gain update/delete/transition permission unless Role permissions already allow it
- removing observer removes that access source
- future Notifications may subscribe observers to relevant changes

If implemented as a generic observer table, server-side code must strongly validate `(workspace, entityType, entityId)` because PostgreSQL cannot enforce one FK to several entity tables.

---

## 10. Permission catalog and authorization

Use separate action permissions rather than generic CRUD alone.

Recommended keys:

```text
crm.lead.create
crm.lead.read
crm.lead.update
crm.lead.delete
crm.lead.assign
crm.lead.convert
crm.lead.transition

crm.contact.create
crm.contact.read
crm.contact.update
crm.contact.delete
crm.contact.assign

crm.company.create
crm.company.read
crm.company.update
crm.company.delete
crm.company.assign

crm.deal.create
crm.deal.read
crm.deal.update
crm.deal.delete
crm.deal.assign
crm.deal.transition

crm.pipeline.read
crm.pipeline.manage
crm.pipeline.transition.override
```

Each permission may carry the Workspace authorization scope supported by Module 02, such as:

```text
OWN
DEPARTMENT
DEPARTMENT_TREE
TEAM
PUBLIC
ALL
```

Authorization order for record actions:

```text
authenticated user
-> active WorkspaceMembership
-> exactly one Workspace Role
-> action permission
-> scope evaluation
-> observer/relationship-derived visibility where explicitly allowed
-> pipeline/stage rule when applicable
-> transition graph when applicable
-> required-field rule when applicable
-> domain validation
```

### Relationship-derived limited visibility

If a user can read a Deal but cannot independently read the linked Contact/Company, Deal detail may expose only the minimal customer summary needed to work the Deal:

- Contact/Company display name
- primary communications
- basic address
- Contact job title where relevant

This does **not** grant full independent access to the Contact/Company detail page, history, activities, other Deals, files, or other protected data.

### Stage permissions

Role stage policy supports at least:

```text
view
enter
leave
```

A transition requires normal entity permission + scope + stage access.

`crm.pipeline.transition.override` may bypass the configured transition graph only.

It must **not** bypass:

- tenant isolation
- entity action permission
- stage access
- required fields
- entity/pipeline type compatibility
- database/domain validity

---

## 11. Lead conversion

Lead conversion is an explicit atomic command.

Conversion may:

```text
Contact: CREATE | LINK_EXISTING | NONE
Company: CREATE | LINK_EXISTING | NONE
Deal:    CREATE | NONE
```

A successful conversion must result in at least one customer identity:

```text
Contact OR Company
```

The backend must never silently select a duplicate Contact/Company.

A Deal created during conversion must obey normal Deal customer requirements.

Conversion may reuse customer relationships already linked to the Lead.

Recommended endpoint:

```text
POST /api/v1/crm/leads/:id/convert
```

The conversion transaction must atomically:

1. load and lock/validate Lead version/state
2. authorize `crm.lead.convert`
3. validate Workspace and requested existing entity IDs
4. validate duplicate/create-vs-link intent
5. create/link Contact as requested
6. create/link CRM Company as requested
7. create Deal if requested
8. copy appropriate source/UTM/origin context to created Deal
9. record conversion outputs in `crm_lead_conversions`
10. set Lead conversion state to CONVERTED
11. write required audit/outbox records
12. commit once

After conversion:

- Lead remains for history/reporting
- Lead cannot be converted twice
- Lead cannot return to normal processing through ordinary transitions
- normal users cannot mutate conversion-critical customer/qualification data
- conversion does not delete the Lead

Lead conversion and duplicate merge are different operations. Merge belongs to Data Quality.

---

## 12. CRM source and acquisition metadata

Use a Workspace-level CRM source catalog rather than free text only.

Recommended source attributes:

- id
- workspaceId
- name
- code
- sortOrder
- isActive
- isSystem where repository policy needs protected built-ins

Example values may include Website, Facebook, Instagram, WhatsApp, Phone Call, Referral, Partner, Manual, Import, Other.

Lead and Deal reference `sourceId` and may include an optional source description/detail.

Lead also stores raw acquisition metadata:

```text
utmSource
utmMedium
utmCampaign
utmContent
utmTerm
originSystem
originExternalId
originVersion
```

When conversion creates a Deal, acquisition context defaults from the Lead but may be explicitly overridden by a valid conversion payload where business rules permit.

The later Sales Intelligence module may interpret/attribute this data. CRM Core remains the source of the raw captured values.

---

## 13. Monetary fields and addresses

Lead supports:

- estimatedAmount
- currencyCode

Deal supports:

- amount
- currencyCode

Lead conversion may default Deal amount/currency from the Lead while allowing an explicit override.

CRM Core supports one ordinary primary CRM address on Lead, Contact and CRM Company:

- addressLine1
- addressLine2
- city
- stateOrProvince
- postalCode
- countryCode

Registered/legal addresses, tax details, bank details and formal requisites belong to the Company Details/Requisites module.

Deals do not duplicate the customer's ordinary address as authoritative customer master data.

---

## 14. Duplicate detection

Duplicate detection checks potential CRM duplicates using normalized communication/customer identifiers as supported by the repository.

Never automatically merge.

On create, if likely duplicates are found and `forceCreate` is not explicitly true:

```text
HTTP 409
CRM_DUPLICATE_DETECTED
```

Response details include safe authorized match summaries.

If an authorized client retries intentionally with:

```text
forceCreate = true
```

creation may proceed.

Duplicate detection and merge are separate. Merge belongs to Data Quality.

---

## 15. Pipeline transitions

Use dedicated transition commands.

Recommended:

```text
POST /api/v1/crm/leads/:id/transition
POST /api/v1/crm/deals/:id/transition
```

Ordinary PATCH must not directly change:

- responsibleUserId
- pipelineId
- stageId
- Lead conversion state

A cross-pipeline transition must explicitly provide both:

```text
targetPipelineId
targetStageId
```

Do not silently pick a stage when moving an existing record between pipelines.

Validate:

- same Workspace
- target pipeline entity type matches record type
- target stage belongs to target pipeline
- action/scope permission
- current-stage leave permission
- target-stage view/enter permission as applicable
- optional transition graph
- target-stage required fields
- optimistic version
- failure/lost-reason requirements

Recommended transition sequence:

```text
load + lock/version check
-> authorize
-> validate pipeline/stage
-> validate transition edge or allowed override
-> resolve target-stage required fields
-> validate current + submitted field values
-> validate failure lost reason if needed
-> update business fields + pipeline/stage
-> append stage history
-> audit
-> outbox
-> commit
```

Automation runs after commit from durable event/outbox processing.

---

## 16. Optional transition graph

Support configurable stage-to-stage rules.

If transition restrictions are disabled/unconfigured, any authorized valid stage move inside the pipeline is allowed.

When enabled, only configured edges are valid unless `crm.pipeline.transition.override` applies.

Recommended storage:

```text
crm_stage_transitions
- workspaceId
- pipelineId
- fromStageId
- toStageId
- isAllowed / active state according to repository convention
```

The implementation may use an explicit `transitionRulesEnabled`/equivalent pipeline flag to distinguish “no graph configured” from “graph configured with zero valid outgoing edges”.

---

## 17. Lost reasons

FAILURE stage and lost reason are separate concepts.

Workspace owns configurable lost reasons.

Entering a FAILURE stage requires:

- active valid lostReasonId
- optional lostReasonComment

Current state stores the active closure reason.

Moving back to PROGRESS clears the active current lost reason/closure state while historical stage/audit evidence remains intact.

Do not rewrite old records when a lost reason is later deactivated.

---

## 18. Stage history

Use separate relational history tables:

```text
crm_lead_stage_history
crm_deal_stage_history
```

This preserves strong foreign keys to the source record.

Each history record captures enough information to reconstruct movement, at minimum:

- workspaceId
- leadId or dealId
- fromPipelineId nullable for creation
- fromStageId nullable for creation
- toPipelineId
- toStageId
- movedByUserId / actor identity
- movedAt
- correlationId where repository infrastructure supports it
- reason/context fields only where safe and required

Stage rename/reorder does not rewrite history.
Pipeline/stage migration does not rewrite old history IDs.

A unified service/API abstraction may read both history types, but persistence remains strongly relational.

---

## 19. Archive, soft delete, restore and hard delete

CRM lifecycle operations are distinct.

### Archive

Archive is a normal reversible business operation.

Required functional fields:

```text
isArchived
archivedAt
archivedByUserId
```

Archived records:

- remain valid
- retain relationships/history
- are excluded from normal lists unless requested
- may be restored from archive

### Soft delete

Required functional fields:

```text
isDeleted
deletedAt
deletedByUserId
```

Soft-deleted records:

- are hidden from normal CRM use
- can be restored with permission
- do not lose immutable audit evidence

### Hard delete

Hard delete is exceptional/admin-controlled.

Rules:

- normally allowed only after soft delete
- must not delete centralized AuditLog evidence
- must be blocked while protected live/business/history references require the entity
- must never silently rewrite customer/Deal/conversion history
- if a later retention policy explicitly allows a domain purge, it must be deliberate and tested

### Referenced customer records

A Contact/CRM Company with protected references such as active Deals or Lead-conversion outputs cannot be soft-deleted until those relationships are resolved according to business rules.

Archive remains available.

---

## 20. Configuration lifecycle

Normal removal of these configuration objects is deactivation, not destructive deletion:

```text
crm_sources
crm_lost_reasons
crm_pipelines
crm_stages
```

Deactivated values:

- cannot be selected for new records
- remain readable for history/reporting
- keep stable IDs
- may be reactivated where safe

Hard deletion is permitted only when the value has never been referenced and repository/audit/retention rules allow it.

---

## 21. Pipeline/stage deletion and migration

### Stage

A stage with live current records cannot simply be deleted.

Admin must supply a replacement stage when current records exist.

The operation must:

1. validate same Workspace/entity type/pipeline rules
2. migrate current records
3. append appropriate stage history
4. deactivate/soft-delete old stage according to repository lifecycle convention
5. write audit/outbox events

Historical stage references keep the original stage ID.

The default stage cannot be removed until another valid PROGRESS default exists.

### Pipeline

A pipeline with current records cannot simply be deleted/deactivated.

Admin supplies an explicit stage mapping from old stages to target pipeline stages.

The operation validates the entire mapping before mutation, migrates current records, appends history, then deactivates the old pipeline/stages.

Historical references are never rewritten.

The last/default active pipeline for an entity type cannot disappear until another valid default is established.

---

## 22. API conventions

Base prefix:

```text
/api/v1
```

Use entity-specific public APIs:

```text
/api/v1/crm/leads
/api/v1/crm/contacts
/api/v1/crm/companies
/api/v1/crm/deals
/api/v1/crm/pipelines
/api/v1/crm/stages
```

Do not expose one generic `/crm/items?entityType=...` public API for these four core entities.

Successful single-resource response:

```json
{
  "success": true,
  "data": {},
  "meta": null
}
```

Error shape:

```json
{
  "success": false,
  "error": {
    "code": "CRM_VERSION_CONFLICT",
    "message": "Human-readable explanation.",
    "details": null
  },
  "requestId": "correlation-id"
}
```

Use stable machine-readable CRM error codes.

### Sensitive command endpoints

Use dedicated commands for:

```text
POST /crm/leads/:id/assign
POST /crm/deals/:id/assign
POST /crm/contacts/:id/assign
POST /crm/companies/:id/assign

POST /crm/leads/:id/transition
POST /crm/deals/:id/transition

POST /crm/leads/:id/convert
```

Equivalent RESTful command naming is acceptable if the repository has a strong convention, but behavior must remain explicit.

### Relationship mutation

After creation, mutate relationships explicitly, e.g.:

```text
POST   /contacts/:contactId/companies
PATCH  /contacts/:contactId/companies/:companyId
DELETE /contacts/:contactId/companies/:companyId

POST   /deals/:dealId/contacts
PATCH  /deals/:dealId/contacts/:contactId
DELETE /deals/:dealId/contacts/:contactId

POST   /deals/:dealId/observers
DELETE /deals/:dealId/observers/:userId

POST   /contacts/:id/communications
PATCH  /contacts/:id/communications/:communicationId
DELETE /contacts/:id/communications/:communicationId
```

Create endpoints may accept initial nested relationships where useful and transactionally safe.

Do not use ordinary PATCH to replace entire relationship arrays by default.

---

## 23. Cursor-based Get-All contract

CRM Core/Pipelines intentionally override the previous Auth pack's page-based pagination.

All CRM Get-All endpoints use cursor pagination.

Minimum query support:

- `search`
- `limit`
- `cursor`
- `sortBy`
- `sortOrder`
- validated advanced filters
- optional archive/deleted inclusion only when authorized

Recommended defaults:

- `limit = 20`
- maximum `limit = 100`
- stable module-specific sort
- always add stable ID tie-breaker matching sort direction

Successful list response:

```json
{
  "success": true,
  "data": [],
  "meta": {
    "limit": 20,
    "nextCursor": null,
    "hasMore": false
  }
}
```

Recommended filter operators, if consistent with the repository shared parser:

```text
eq
neq
in
notIn
contains
startsWith
endsWith
gt
gte
lt
lte
isNull
```

Rules:

- explicitly whitelist searchable fields per endpoint
- explicitly whitelist sortable/filterable fields
- never expose arbitrary Prisma fields from client input
- never interpolate raw client strings into SQL
- cursor must encode enough sort/tie-breaker state to avoid duplicate/missing rows under normal pagination
- authorization scope must be applied before page extraction

---

## 24. List vs detail response depth

List endpoints return summary-friendly fields only.

Deal list example may include:

- id
- title
- amount/currency
- responsible summary
- customer summary
- pipeline/stage
- derived status
- source
- createdAt/updatedAt
- version

Detail endpoints return direct Module 03/04 data, including relevant customer relationships, observers, source, pipeline/stage, current closure/lost reason, UTM/origin and ordinary addresses.

Heavy histories may be explicitly included through supported query flags such as:

```text
?include=stageHistory,conversionHistory
```

Do not automatically embed future-module datasets such as Activities, Products, Files, Timeline or Payments in every detail response.

---

## 25. Idempotency

Support `Idempotency-Key` for non-idempotent CRM commands, including at minimum:

- record creation
- Lead conversion
- stage transition
- assignment command
- relationship creation

Conceptual storage:

```text
workspaceId
actor/client identity
operation
idempotencyKey
requestHash
stored result/response reference
expiresAt
```

Rules:

- key scope includes Workspace and operation/client identity as appropriate
- same key + same request returns original result
- same key + different payload returns `409 IDEMPOTENCY_KEY_REUSED`
- minimum retention = 24 hours
- expired rows may be cleaned asynchronously
- never store sensitive raw payload values unnecessarily

Idempotency does not replace transaction isolation, unique constraints or optimistic concurrency.

---

## 26. Optimistic concurrency

Mutable CRM records use a `version` field or the repository's equivalent optimistic-lock primitive.

Update/assign/transition/relationship commands that mutate versioned aggregate state must require/validate expected version where applicable.

Stale mutation returns:

```text
HTTP 409
CRM_VERSION_CONFLICT
```

Do not silently use last-write-wins for core CRM aggregate updates.

Use database transactions/row locks where required for conversion, transition, migration and other critical multi-row operations.

---

## 27. Cross-Workspace probing protection

For resource-by-ID operations:

```text
record does not exist
OR
record exists in another Workspace
```

must both appear as:

```text
404 CRM_<ENTITY>_NOT_FOUND
```

Do not return 403 in a way that confirms another tenant's UUID exists.

For a same-Workspace record that exists but the user lacks permission, normal 403 permission errors may be used.

Apply this to Leads, Contacts, Companies, Deals, Pipelines, Stages and relationship/configuration IDs.

---

## 28. Stable error codes

At minimum define and test stable errors equivalent to:

```text
CRM_LEAD_NOT_FOUND
CRM_CONTACT_NOT_FOUND
CRM_COMPANY_NOT_FOUND
CRM_DEAL_NOT_FOUND
CRM_PIPELINE_NOT_FOUND
CRM_STAGE_NOT_FOUND

CRM_DUPLICATE_DETECTED
CRM_VERSION_CONFLICT

CRM_INVALID_PIPELINE
CRM_INVALID_STAGE
CRM_STAGE_WRONG_PIPELINE
CRM_PIPELINE_ENTITY_TYPE_MISMATCH

CRM_TRANSITION_NOT_ALLOWED
CRM_STAGE_PERMISSION_DENIED
CRM_STAGE_REQUIRED_FIELDS_MISSING
CRM_LOST_REASON_REQUIRED

CRM_CUSTOMER_REQUIRED
CRM_PRIMARY_RELATION_REPLACEMENT_REQUIRED

CRM_ALREADY_CONVERTED
CRM_CONVERSION_INVALID

CRM_ACTIVE_REFERENCES_EXIST
CRM_REPLACEMENT_REQUIRED

CRM_DEFAULT_PIPELINE_REQUIRED
CRM_DEFAULT_STAGE_REQUIRED
CRM_PIPELINE_STRUCTURE_INVALID

IDEMPOTENCY_KEY_REUSED
```

Map them to stable HTTP semantics:

- 400 validation/request semantics
- 403 same-Workspace permission denied
- 404 not found / hidden cross-Workspace resource
- 409 business conflict, duplicate warning, stale version, incompatible current state

Use repository-wide validation conventions consistently.

---

## 29. Audit and outbox events

### Audit

Important mutations are independently represented in centralized immutable AuditLog.

At minimum cover:

```text
CRM.LEAD.CREATED
CRM.LEAD.UPDATED
CRM.LEAD.ASSIGNED
CRM.LEAD.STAGE_CHANGED
CRM.LEAD.CONVERTED
CRM.LEAD.ARCHIVED
CRM.LEAD.RESTORED
CRM.LEAD.SOFT_DELETED

CRM.CONTACT.CREATED
CRM.CONTACT.UPDATED
CRM.CONTACT.ASSIGNED
CRM.CONTACT.COMPANY_LINKED
CRM.CONTACT.COMMUNICATION_ADDED

CRM.COMPANY.CREATED
CRM.COMPANY.UPDATED
CRM.COMPANY.ASSIGNED

CRM.DEAL.CREATED
CRM.DEAL.UPDATED
CRM.DEAL.ASSIGNED
CRM.DEAL.STAGE_CHANGED
CRM.DEAL.CONTACT_LINKED
CRM.DEAL.ARCHIVED
CRM.DEAL.SOFT_DELETED

CRM.PIPELINE.CREATED
CRM.PIPELINE.UPDATED
CRM.PIPELINE.DEACTIVATED
CRM.PIPELINE.MIGRATED

CRM.STAGE.CREATED
CRM.STAGE.UPDATED
CRM.STAGE.DEACTIVATED
CRM.STAGE.MIGRATED
```

Audit contains actor, Workspace, action, entity, entity ID, timestamp/correlation and sanitized before/after/change evidence where appropriate.

Audit is not the same as business stage history or future user-facing Timeline.

### Outbox/domain event envelope

Prefer compact events:

```text
eventId
eventType
occurredAt
workspaceId
entityType
entityId
actorUserId
correlationId
entityVersion
changedFields
```

Operation metadata examples:

Transition:

```text
fromPipelineId
fromStageId
toPipelineId
toStageId
```

Lead conversion:

```text
leadId
contactId
companyId
dealId
```

Assignment:

```text
fromResponsibleUserId
toResponsibleUserId
```

Do not put the entire CRM record, every phone/email/address or other unnecessary PII into every event.

Consumers such as Search, Timeline, Automation, Analytics and Notifications may load the data they need under their authorization/system policy.

---

## 30. Required-field integration boundary

Stage-required field definitions belong to Module 05 — Custom & Required Fields.

Pipelines invokes a requirement resolver/interface.

When entering a stage:

- resolve system and custom fields required for the target stage
- validate existing record values plus values submitted in the same transition command
- reject transition with stable field-level details if requirements are missing

Do not implement a second custom-field engine inside Pipelines.

If Module 05 is not yet implemented, create the narrow interface/adapter required by this contract and use a deterministic no-custom-rules implementation only where explicitly appropriate. Do not claim external custom-field behavior was implemented if it was not.

---

## 31. Database constraints and indexes

Use database constraints wherever PostgreSQL can enforce a locked invariant safely.

Examples:

- same-record relationship uniqueness such as `(dealId, contactId)`
- `(contactId, companyId)` uniqueness
- case-insensitive pipeline-name uniqueness per Workspace + entityType
- maximum one active default pipeline per Workspace + entityType using an appropriate partial unique index/constraint strategy
- maximum one active default stage per pipeline
- communication primary uniqueness per entity/type where feasible
- primary relationship uniqueness where feasible
- valid enum/domain values
- foreign keys to same-domain parents

Some invariants, such as “exactly one SUCCESS stage in every active pipeline”, require transactional service validation because a simple row CHECK cannot count sibling rows. Enforce them transactionally and cover them with database/integration tests.

Index common queries:

- workspace + responsible user
- workspace + pipeline/stage
- workspace + source
- workspace + lifecycle flags
- normalized communication values used by duplicate detection
- relationship joins
- stage-history record/time
- updatedAt/createdAt or repository-equivalent cursor sort fields

Do not add speculative indexes without query justification.

---

## 32. Production-safe migration rules

Before schema changes:

1. inspect `schema.prisma`
2. inspect relevant existing migrations
3. inspect existing CRM tables/data if present
4. never rewrite an already-applied migration
5. add a new migration
6. use expand -> backfill -> validate -> enforce when a required field cannot be introduced safely in one step
7. validate Prisma schema
8. regenerate Prisma Client if required
9. run migration/integration tests
10. run full regression suite

Never automatically execute production migrations.

### Existing Workspace bootstrap/backfill

For existing Workspaces lacking valid pipeline configuration, create the default Lead and Deal pipelines described in this pack.

For existing records with no previous pipeline/stage data, backfill to the correct `New` stage.

If legacy status/stage values exist, preserve them through an explicit deterministic mapping.

If the mapping cannot be proven from repository/data:

```text
STOP
report unmapped legacy values
DO NOT silently assign them all to New
```

Only enforce final NOT NULL/FK/check/unique constraints after backfill validation proves data is compatible.

---

## 33. Repository-first execution rules

Before editing:

1. Read this file completely.
2. Read the relevant module spec files.
3. Inspect `package.json` and package manager lockfile.
4. Inspect NestJS module layout and naming conventions.
5. Inspect `schema.prisma` and existing migrations.
6. Inspect current Workspace/auth guards, permission decorators/services and audit/outbox patterns.
7. Inspect shared response/error/interceptor conventions.
8. Inspect current query/list infrastructure.
9. Inspect existing idempotency/job/outbox infrastructure before adding a duplicate implementation.
10. Inspect testing framework/scripts and existing test helpers/fixtures.
11. Identify directly necessary cross-module changes.

Do not invent repository state.

Do not add a second competing permission engine, idempotency engine, outbox bus, audit service or query parser if one already exists and can satisfy the contract.

---

## 34. Testing execution mode

The `tests/modules/CRM_Core_Pipelines/` directory contains executable TypeScript contract tests. They intentionally fail until wired to the repository.

For requested scope:

1. read matching specifications
2. read matching contract tests
3. adapt tests into repository Jest/Vitest layout
4. replace the placeholder `contract()` calls with real setup/assertions
5. do not delete/skip/weaken required scenarios
6. implement production code
7. run unit/service tests
8. run real DB/integration tests
9. run API E2E tests
10. run permission-negative tests
11. run cross-Workspace isolation tests
12. run cursor-query tests
13. run archive/delete/restore tests
14. run idempotency/concurrency tests
15. run migration/backfill tests where schema changes exist
16. run full regression suite
17. fix failures and repeat until green

Mocks/fakes are acceptable for external/future modules only at a clearly defined interface boundary. Do not mock away the database transaction, authorization or state machine behavior that this pack is supposed to prove.

---

## 35. Definition of FINISHED

The agent may report:

```text
<Scope> — FINISHED
```

only when all applicable conditions are true.

### Database

- schema implemented
- migrations generated
- production migration safety reviewed
- constraints/indexes implemented
- Prisma validates
- Prisma Client regenerated if required

### CRM Core

- Leads implemented
- Contacts implemented
- CRM Companies implemented
- Deals implemented
- normalized communications implemented
- relationships implemented
- source handling implemented
- Lead conversion implemented
- acquisition metadata implemented
- archive/delete lifecycle implemented
- responsible user + observers implemented

### Pipelines

- Lead pipelines implemented
- Deal pipelines implemented
- bootstrap defaults implemented
- stage semantics implemented
- transitions implemented
- cross-pipeline moves implemented
- lost reasons implemented
- required-field integration boundary implemented
- stage history implemented
- stage/pipeline migration + deactivation implemented

### Security

- Workspace isolation enforced
- scopes enforced
- stage permissions enforced
- observer access behaves correctly
- limited relationship-derived visibility behaves correctly
- cross-tenant probing does not reveal existence

### Reliability

- idempotency works
- optimistic concurrency works
- critical transactions are atomic
- audit works
- outbox/domain events work

### API

- DTO validation passes
- cursor list/filter/sort works
- dedicated sensitive command endpoints enforced
- stable error codes implemented
- Swagger/OpenAPI updated if repository uses it

### Testing

- new contract tests pass
- integration/DB tests pass
- E2E tests pass
- authorization-negative tests pass
- migration tests pass where applicable
- full existing regression suite passes
- no required tests weakened/skipped/todo'd to fake completion
- no known regression remains
- final diff reviewed for scope

If a later module is genuinely unavailable, implement and test the defined interface boundary, document the dependency, and do not falsely claim that future module's full behavior exists.
