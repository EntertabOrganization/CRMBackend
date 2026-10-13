# Bank Data Specification

> **Backend-only implementation scope:** This specification authorizes server-side work only: database schema and migrations, domain/application services, REST APIs, authorization, audit/outbox events, workers/jobs, provider adapters, and automated backend tests. Do not create, modify, scaffold, or test frontend pages, UI components, browser views, styling, or client-side application code. Any UI/browser wording below defines backend-facing behavior or security constraints only.


## Goal

Store multiple sensitive bank accounts/details under a Requisite with dedicated permissions, auditing and historical snapshot behavior.

## Entity

Use repository-consistent naming such as `company_financial_details` or `requisite_bank_accounts` while preserving the following domain contract.

Logical fields:

```text
id UUID
workspaceId UUID
requisiteId UUID
name string
countryCode string
currencyCode nullable string
bankName nullable string
accountHolderName nullable string
accountNumber/IBAN country-specific value
swiftBic nullable string
routing/branch/country-specific identifiers as configured
isDefault boolean
active boolean
```

This is bank/legal identity data, not a card vault. Do not store card PAN/CVV.

## Permissions

Dedicated permissions are mandatory:

```text
bank_data.view
bank_data.create
bank_data.update
bank_data.set_default
bank_data.archive
bank_data.restore
```

`requisite.read` alone is insufficient to return sensitive Bank Data.

When caller can see Requisite but lacks `bank_data.view`, API/search/export/event behavior must not leak bank values.

## Validation

- bank record belongs to same Workspace Requisite;
- country-specific fields driven by preset/config;
- currency valid if supplied;
- IBAN/account/SWIFT validation only claims syntactic/checksum validation actually implemented;
- at most one default per configured Requisite/context/currency;
- default changes atomic under concurrency.

## API

```text
GET  /api/v1/requisites/:id/bank-accounts
POST /api/v1/requisites/:id/bank-accounts
GET  /api/v1/requisites/:id/bank-accounts/:bankId
PATCH /api/v1/requisites/:id/bank-accounts/:bankId
POST /api/v1/requisites/:id/bank-accounts/:bankId/set-default
POST /api/v1/requisites/:id/bank-accounts/:bankId/archive
POST /api/v1/requisites/:id/bank-accounts/:bankId/restore
```

## Audit and privacy

Audit create/update/default/archive/restore. If read-access auditing is configured, log that Bank Data was viewed without copying full account values into audit.

Never log full sensitive account values in normal application logs. Apply repository masking/redaction/encryption rules.

## Commercial use

Estimate/Invoice can choose one active eligible bank account. Commercial document stores required Bank Data in immutable snapshot.

Later master edit/archive does not change sent/issued document.

Archived account cannot be newly selected but remains historically represented in snapshots.

## Errors

```text
BANK_DATA_NOT_FOUND
BANK_DATA_PERMISSION_DENIED
BANK_DATA_INVALID
BANK_DATA_DEFAULT_CONFLICT
BANK_DATA_REFERENCED
CROSS_WORKSPACE_REFERENCE
```

## Acceptance criteria

- Requisite can have several bank accounts;
- Requisite reader without `bank_data.view` cannot retrieve sensitive values;
- default change deterministic under concurrency;
- bank edit is audited without secret leakage;
- issued snapshot unchanged after bank edit/archive;
- bank ID from another Workspace cannot resolve.
