# CRM Source & Acquisition Specification

## Goal

Provide stable Workspace-level CRM source classification while preserving raw acquisition metadata needed by later attribution modules.

## CRM source catalog

Recommended model:

- id UUID
- workspaceId
- name
- code
- sortOrder
- isActive
- isSystem where protected built-ins are needed

Lead and Deal reference `sourceId`.

Optional `sourceDescription` may preserve free-form context.

## Example sources

Examples only, not a mandatory hard-coded list:

- Website
- Facebook
- Instagram
- WhatsApp
- Phone Call
- Referral
- Partner
- Manual
- Import
- Other

Workspace admins may manage sources according to permissions.

## Acquisition fields

Lead stores raw:

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

Conversion-created Deal inherits appropriate values by default.

Later Sales Intelligence/Attribution may add multi-touch/session/provider interpretation. Do not implement that engine here.

## Deactivation

Deactivated source:

- cannot be newly selected
- remains readable on historical records
- keeps stable ID
- may be reactivated when safe

Hard delete only when never referenced and retention/audit rules permit.

## Acceptance criteria

- Lead/Deal source filtering works
- deactivated source remains historical
- UTM/origin persists on Lead
- conversion can copy acquisition context to Deal
