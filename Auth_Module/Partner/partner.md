# Partner Module Specification

## Goal

Implement Partner as a separate platform-level organization model.

Partner is NOT:
- a Workspace Role
- a flag on User
- a Workspace owner
- an implicit Workspace membership

One global User may simultaneously have WorkspaceMembership and PartnerMembership.

## Partner application flow

Public action:

```text
Become a Partner
```

Recommended input:
- firstName
- lastName
- email
- phone
- partnerName
- country
- website optional
- businessDescription
- acceptance of Terms/Privacy

Flow:
1. create/reuse global User identity
2. verify email if required by auth state
3. create PartnerApplication with `PENDING`
4. Platform Admin reviews
5. APPROVED or REJECTED

Application statuses:

```text
PENDING
APPROVED
REJECTED
```

Rejected application:
- keep User account
- retain application history
- allow later reapplication

## Partner approval

Only Platform Admin may approve.

Approval transaction creates:
- Partner organization
- PartnerMembership for applicant
- protected Partner Owner role
- default Partner discount configuration
- required AuditLog rows

Commit atomically.

## Partner model

Suggested:
- id UUID
- name
- country
- website nullable
- businessDescription nullable
- status ACTIVE | SUSPENDED
- defaultDiscount
- settings/meta as required
- isDeleted

## PartnerMembership

Separate from WorkspaceMembership.

Suggested:
- id UUID
- partnerId
- userId
- partnerRoleId
- status
- isDeleted

A User may have one Partner Role per Partner.

Partner internal roles may include:
- Partner Owner
- Sales
- Finance
- Support
- custom roles later

## Partner discounts

Use both:
- `defaultDiscount`
- per-product/category overrides

Example:

```text
Default       = 10%
Subscription  = 20%
AI Credits    = 15%
```

Rules:
- Platform Admin can update later
- discount must never leak to unrelated Partner/Workspace
- future billing transactions must snapshot the effective discount used

The detailed billing ledger belongs to billing modules; this Partner module must provide the authoritative Partner discount configuration.

## Customer Workspace provisioning

Partner may create/provision customer Workspaces.

Rules:
- real customer User becomes Workspace owner
- Partner does not automatically become Owner/Admin
- normal Workspace bootstrap is reused
- Partner relationship recorded separately
- customer Workspace can have maximum one active Partner relationship at a time

## Commercial relationship vs operational access

Commercial relation:

```text
Partner <-> Workspace
```

does NOT grant tenant access.

Operational access requires separate explicit delegated record, e.g.:

```text
PartnerWorkspaceAccess
```

Suggested fields:
- id
- partnerId
- workspaceId
- status
- permission-set/reference
- grantedBy
- functional expiry where needed
- revoked state where needed
- isDeleted if lifecycle requires

Rules:
- no implicit WorkspaceMembership
- no implicit Workspace ownership
- access may be revoked independently from billing/commercial history
- Partner user may switch/access customer Workspace only where Partner permissions and delegated Workspace access both allow it

## Get-All dynamic queries

Partner, applications and delegated-access lists use the shared query system.

Recommended Partner searchable:
- name
- country
- website where safe

Application searchable:
- applicant name
- email
- partnerName

Filterable:
- status
- isDeleted
- application status
- country

## Audit events

At minimum:
- PARTNER.APPLICATION_SUBMITTED
- PARTNER.APPLICATION_APPROVED
- PARTNER.APPLICATION_REJECTED
- PARTNER.CREATED
- PARTNER.UPDATED
- PARTNER.SUSPENDED
- PARTNER.REACTIVATED
- PARTNER.DISCOUNT_UPDATED
- PARTNER.MEMBER_ADDED
- PARTNER.MEMBER_ROLE_CHANGED
- PARTNER.WORKSPACE_RELATION_CREATED
- PARTNER.WORKSPACE_RELATION_ENDED
- PARTNER.WORKSPACE_ACCESS_GRANTED
- PARTNER.WORKSPACE_ACCESS_REVOKED
- PARTNER.SOFT_DELETED
- PARTNER.RESTORED
- PARTNER.HARD_DELETED

## Acceptance criteria

- Partner membership is separate from Workspace membership
- Partner approval is Platform Admin only
- approval creates organization/membership/owner role/discount atomically
- one active Partner relation per customer Workspace
- Partner never becomes Workspace owner implicitly
- commercial relation never automatically grants operational Workspace access
- delegated access can be revoked independently
- rejected applicant keeps User and may reapply
- dynamic query remains isolated and authorized
