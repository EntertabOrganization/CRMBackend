# CRM Company Specification

## Goal

Implement CRM Company as the authoritative customer/account/business organization record.

CRM Company is **not** the Workspace tenant.

## Core rules

- Workspace scoped.
- May relate to multiple Contacts.
- May own/participate in multiple Deals.
- May be linked to multiple Leads over time.
- Exactly one responsible user.
- Ordinary CRM address belongs here; legal/tax/bank/requisite data belongs to the later Company Details/Requisites module.

## Suggested persistent fields

- id UUID
- workspaceId
- name
- responsibleUserId
- ordinary CRM address fields
- isArchived / archivedAt / archivedByUserId
- isDeleted / deletedAt / deletedByUserId
- createdAt
- updatedAt
- version

## Communications

Support normalized PHONE, EMAIL, WEB and IM values through the Company communication model.

## Contacts

Company ↔ Contact is many-to-many.

Do not collapse this into one `contactId` field.

Primary relationship is represented from the Contact side as the Contact's primary Company relationship.

## Deal behavior

A Deal may point to one Company and may simultaneously link multiple Contacts.

Company is not mutually exclusive with Deal Contacts.

## Deletion protection

Soft delete is rejected while protected live/business references require the Company, such as active Deals or Lead conversion outputs.

Archive remains available.

Hard delete is more restrictive and must preserve centralized audit evidence.

## Acceptance criteria

- Company is distinct from Workspace
- multiple Contacts can link to Company
- one Company can be used by many Deals
- communications/address work
- duplicate warning/force-create works
- referenced-record delete protection works
- cross-Workspace relationship IDs are rejected/hidden
