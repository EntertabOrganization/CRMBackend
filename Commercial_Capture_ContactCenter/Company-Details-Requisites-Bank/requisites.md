# Requisites Core Specification

> **Backend-only implementation scope:** This specification authorizes server-side work only: database schema and migrations, domain/application services, REST APIs, authorization, audit/outbox events, workers/jobs, provider adapters, and automated backend tests. Do not create, modify, scaffold, or test frontend pages, UI components, browser views, styling, or client-side application code. Any UI/browser wording below defines backend-facing behavior or security constraints only.


## Goal / Boundary

Store legal and billing identity separately from ordinary CRM Contact/Company profile data.

A Requisite belongs to one CRM Contact or CRM Company. A Contact/Company may have several Requisites. Seller/My Company behavior is configured on CRM Companies and seller bindings rather than by inventing a disconnected duplicate company entity.

## Requisite entity

`crm_requisites` logical fields:

```text
id UUID
workspaceId UUID
ownerType CONTACT | COMPANY
ownerId UUID
presetId UUID
name/displayName string
legalName / individual legal fields as preset defines
countryCode string
entityTypeCode string
isDefault boolean / contextual default metadata
active boolean
customValues repository metadata model
```

Common high-value fields may be physical columns; country-specific fields may use preset metadata/value storage.

## Ownership rules

- owner exists and is same Workspace;
- Requisite owner type cannot silently change after historical use;
- multiple Requisites allowed;
- default selection is deterministic and unique per defined context;
- ordinary CRM Company profile does not substitute for required legal Requisite data.

## API

```text
POST   /api/v1/crm/contacts/:contactId/requisites
POST   /api/v1/crm/companies/:companyId/requisites
GET    /api/v1/requisites
GET    /api/v1/requisites/:id
PATCH  /api/v1/requisites/:id
POST   /api/v1/requisites/:id/set-default
POST   /api/v1/requisites/:id/archive
POST   /api/v1/requisites/:id/restore
```

Hard delete is allowed only for clearly unreferenced data and only if retention/audit policy permits. Referenced Requisites are archived/deactivated.

## Validation

- preset is available to Workspace and matches country/entity type;
- preset-required fields present;
- preset format/type rules enforced server-side;
- country-specific tax/registration validation claims only rules actually implemented;
- custom field types valid;
- default uniqueness enforced transactionally;
- cross-Workspace owner/preset rejected.

## Permissions

```text
requisite.create
requisite.read
requisite.update
requisite.set_default
requisite.archive
requisite.restore
```

Bank Data has separate permissions.

## Events

```text
REQUISITE_CREATED
REQUISITE_UPDATED
REQUISITE_DEFAULT_CHANGED
REQUISITE_ARCHIVED
REQUISITE_RESTORED
```

## Historical behavior

Current Requisite remains editable after commercial use. Existing Estimate/Invoice snapshots do not change.

Archived Requisite remains historically resolvable to authorized support/audit flows.

## Acceptance criteria

- Contact and Company can each own multiple Requisites;
- default is deterministic;
- country/entity preset requirements are enforced;
- master legal edit after issue does not change issued Invoice;
- referenced Requisite cannot be destructively removed;
- ordinary Company read does not imply Bank Data access;
- cross-Workspace ownership impossible.
