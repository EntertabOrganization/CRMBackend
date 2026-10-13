# CRM Relationships Specification

## Goal

Implement direct CRM relationship rules without silently granting ownership or broad authorization.

## Contact ↔ Company

Many-to-many through a join model.

Minimum relationship data:

- id
- workspaceId
- contactId
- companyId
- jobTitle nullable
- department nullable
- isPrimary
- sort/order optional

Constraints:

- unique `(contactId, companyId)`
- same Workspace for Contact and Company
- maximum one primary Company per Contact

Primary removal rule:

If other Company relationships remain, removing the current primary requires explicit `replacementPrimaryCompanyId`.

## Deal ↔ Contacts

Minimum relationship data:

- id
- workspaceId
- dealId
- contactId
- role nullable
- isPrimary
- sort/order optional

Constraints:

- unique `(dealId, contactId)`
- same Workspace
- if one or more Contact links exist, exactly one primary

Primary removal requires explicit replacement when other Contacts remain.

## Deal ↔ Company

Deal may reference one Company directly.

Company and Contacts may coexist on the same Deal.

At least Company or one Contact must exist for a valid Deal.

## Lead existing-customer links

Lead may link to existing Company/Contacts before conversion.

Physical persistence may follow an existing repository relationship abstraction, but behavior must preserve:

- same-Workspace validation
- no conversion merely because a relationship was linked
- explicit create/link decision during conversion

## Observers

Use the observer behavior from Agent.md. Observer is not responsibility/ownership.

## Authorization

Relationship mutation requires permission to mutate the parent aggregate plus any specific action permission required by repository policy.

Linking a relation never bypasses target-entity tenant checks.

## Acceptance criteria

- Contact can belong to multiple Companies
- Company can have multiple Contacts
- relationship-specific job data works
- Deal can have Company + Contacts
- primary replacement is explicit
- relation changes are auditable
- no cross-Workspace link is possible
