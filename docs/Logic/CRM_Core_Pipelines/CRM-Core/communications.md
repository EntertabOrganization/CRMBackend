# CRM Communications Specification

## Goal

Provide normalized CRM contact-point storage for Leads, Contacts and CRM Companies.

## Supported types

```text
PHONE
EMAIL
WEB
IM
```

Actual messages/conversations are out of scope.

## Storage

Prefer strong parent FKs with separate tables aligned to current architecture:

```text
crm_lead_communications
crm_contact_communications
crm_company_communications
```

If the real repository already has a safe shared communication abstraction, reuse it only if strong tenant/parent integrity and this contract remain satisfied.

## Common attributes

- id UUID
- workspaceId
- parent entity ID
- type
- value
- label/type code such as WORK, PERSONAL, MOBILE, OTHER where meaningful
- isPrimary
- createdAt
- updatedAt

## Rules

- multiple values of the same type allowed
- maximum one primary per communication type per parent
- same-Workspace parent validation required
- normalize values for duplicate search without destroying user-entered display value where repository supports both canonical/display forms
- never use communication rows to grant CRM ownership
- soft/hard-delete behavior must not corrupt retained parent history

## API

Prefer explicit communication mutation endpoints after initial creation.

Examples:

```text
POST   /api/v1/crm/contacts/:id/communications
PATCH  /api/v1/crm/contacts/:id/communications/:communicationId
DELETE /api/v1/crm/contacts/:id/communications/:communicationId
```

Equivalent Lead/Company endpoints apply.

## Acceptance criteria

- PHONE/EMAIL/WEB/IM supported
- multiple values supported
- one primary per type enforced under concurrency
- duplicate detection can use normalized phone/email values
- cross-Workspace communication IDs cannot be attached
