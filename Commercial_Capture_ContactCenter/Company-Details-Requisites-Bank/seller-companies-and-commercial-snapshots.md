# Seller Companies and Commercial Snapshots Specification

> **Backend-only implementation scope:** This specification authorizes server-side work only: database schema and migrations, domain/application services, REST APIs, authorization, audit/outbox events, workers/jobs, provider adapters, and automated backend tests. Do not create, modify, scaffold, or test frontend pages, UI components, browser views, styling, or client-side application code. Any UI/browser wording below defines backend-facing behavior or security constraints only.


## Goal

Configure CRM Companies as Workspace seller/My Company legal entities, select deterministic defaults, and create immutable buyer/seller snapshots used by Estimates, Invoices and generated Documents.

## Seller company model

Use CRM Company as the base entity. Add seller configuration/binding, e.g. `seller_company_bindings`:

```text
id UUID
workspaceId UUID
companyId UUID
active boolean
isWorkspaceDefault boolean
context/pipeline/source rules nullable
preferredRequisiteId nullable UUID
preferredBankAccountId nullable UUID
```

A Workspace may have multiple seller companies.

Exactly one Workspace default may be active when commercial modules require a default. Contextual defaults may override it by deterministic rule priority.

Do not create a second unrelated Company system containing duplicated identity data.

## Seller resolution

For a new Draft Estimate/Invoice:

1. explicit authorized seller selection if supplied;
2. contextual default matching configured context;
3. Workspace default;
4. otherwise `SELLER_REQUIRED`.

Validate Company -> Requisite -> Bank ownership chain and Workspace.

## Commercial snapshot

Use `crm_commercial_snapshots` or repository-equivalent immutable model.

Snapshot stores complete historical rendering data for one role:

```text
id UUID
workspaceId UUID
role BUYER | SELLER
sourceOwnerType CONTACT | COMPANY
sourceOwnerId UUID
sourceRequisiteId UUID
sourceBankAccountId nullable UUID
countryCode
entity/legal type
legal name
registration/tax fields required by template
selected address structured snapshot
selected bank structured snapshot when applicable
createdAt timestamptz
snapshotVersion
```

Source IDs exist for traceability, but values are copied. Historical document must not depend on live master joins.

Snapshot attached to sent Estimate Revision or issued Invoice is immutable.

## Snapshot creation service

Conceptual command:

```text
createCommercialPartySnapshot(
  workspace,
  role,
  owner,
  requisite,
  addressSelection,
  bankSelection,
  documentContext
)
```

Must:
- authorize caller/domain service;
- validate ownership chain;
- resolve preset-required document fields;
- copy values;
- retain source IDs;
- apply storage security;
- write `COMMERCIAL_IDENTITY_SNAPSHOT_CREATED`.

## Generated documents

Old issued/sent document regeneration reads stored snapshot, so current master edits do not alter historical rendering.

A corrected document uses an explicit new version/reissue flow rather than mutating old snapshot.

## Permissions

```text
seller_company.manage
seller_company.read
```

Snapshot read follows commercial document permissions and sensitive-data policy.

A rendered issued Invoice may legitimately contain bank details that were part of that document even if caller cannot browse unrelated current Bank Data. Do not expose extra master account data beyond snapshot/document scope.

## Events

```text
SELLER_COMPANY_ENABLED
SELLER_COMPANY_DISABLED
SELLER_COMPANY_DEFAULT_CHANGED
COMMERCIAL_IDENTITY_SNAPSHOT_CREATED
```

## Acceptance criteria

- multiple seller CRM Companies supported;
- default/context seller resolution deterministic;
- Requisite/Bank from wrong ownership chain rejected;
- snapshot copies values and remains stable after master edit;
- old issued document regenerates from same snapshot;
- snapshot immutability enforced.
