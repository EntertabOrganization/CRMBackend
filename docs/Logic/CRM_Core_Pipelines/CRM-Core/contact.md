# Contact Specification

## Goal

Implement Contact as the authoritative CRM person/customer record.

## Core rules

- Contact is Workspace scoped.
- Contact may relate to multiple CRM Companies.
- Contact may participate in multiple Deals.
- Contact may be linked by multiple Leads/inquiries where the repository relation model supports it.
- Contact has exactly one responsible user.
- Contact supports observers where generic observer behavior applies.

## Suggested persistent fields

- id UUID
- workspaceId
- firstName
- lastName
- display/full name derived or stored according to repository convention
- responsibleUserId
- ordinary CRM address fields
- isArchived / archivedAt / archivedByUserId
- isDeleted / deletedAt / deletedByUserId
- createdAt
- updatedAt
- version

Do not put one authoritative `companyId` on Contact if that would replace the many-to-many relationship model.

## Communications

Contact supports normalized:

- PHONE
- EMAIL
- WEB
- IM

Multiple values per type are allowed; at most one primary per type.

## Company relationships

Use `crm_contact_companies` or repository-equivalent join model.

Relationship-specific values include:

- jobTitle
- department
- isPrimary
- optional sort/order

A Contact may have several Companies but at most one primary Company relationship.

Deleting/removing the primary relation while others remain requires an explicit replacement primary Company.

## Deal access

Being linked as a Contact on a Deal does not make the Contact OWN for authorization.

A user who can read a Deal but not this Contact independently receives only the limited relationship-derived summary defined in Agent.md.

## Deletion protection

Archive is always the safer normal lifecycle operation.

Soft delete is blocked while protected active/business relationships require the Contact identity, including active Deals or retained conversion outputs according to repository retention policy.

Never silently remove the Contact from historical conversion/deal evidence.

## Acceptance criteria

- multiple Company relationships work
- relationship job title/department can differ by Company
- one primary Company relationship maximum
- normalized communications work
- duplicate warning/force-create works
- assignment rules work
- referenced-record delete protection works
- authorization does not treat Deal linkage as OWN
