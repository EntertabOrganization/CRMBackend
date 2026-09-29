# Recurring Invoices Specification

> **Backend-only implementation scope:** This specification authorizes server-side work only: database schema and migrations, domain/application services, REST APIs, authorization, audit/outbox events, workers/jobs, provider adapters, and automated backend tests. Do not create, modify, scaffold, or test frontend pages, UI components, browser views, styling, or client-side application code. Any UI/browser wording below defines backend-facing behavior or security constraints only.


## Goal

Generate Invoice occurrences from a durable recurring rule without duplicate creation and with configurable Draft-only versus automatic issue/send behavior.

This is CRM customer invoicing recurrence, not TrueCRM SaaS subscription billing.

## Entities

### `crm_recurring_invoice_rules`

```text
id UUID
workspaceId UUID
name string
active boolean
customerContactId nullable UUID
customerCompanyId nullable UUID
sellerCompanyId UUID
sourceTemplateInvoiceId nullable UUID
currencyCode string
recurrence definition
ianaTimezone string
startOn DATE
endOn nullable DATE
nextRunAt timestamptz
issueMode DRAFT_ONLY | AUTO_ISSUE_SEND
paymentTerms / due-date rule
responsibleUserId nullable UUID
```

Store line/template data in a repository-consistent rule/template representation. Each generated Invoice receives its own commercial snapshot.

### `crm_recurring_invoice_occurrences`

```text
id UUID
workspaceId UUID
ruleId UUID
occurrenceKey string
scheduledFor timestamptz
invoiceId nullable UUID
status PENDING | CREATED | FAILED | SKIPPED
failureCode nullable string
```

Unique `(ruleId, occurrenceKey)` is mandatory.

## Scheduler flow

1. scheduler identifies due active rules;
2. enqueue idempotent occurrence job;
3. create/reserve occurrence by unique key;
4. recheck rule still active/eligible;
5. create Invoice using normal Invoice service;
6. `DRAFT_ONLY` stops at Draft;
7. `AUTO_ISSUE_SEND` calls normal issue command and enqueues configured delivery;
8. mark occurrence CREATED and link Invoice;
9. calculate/store next run;
10. audit/outbox.

A crash/retry after Invoice creation must recover the same occurrence/Invoice rather than create another.

## Editing rules

- edits affect future occurrences only;
- generated Invoices remain independent history;
- disabling a rule prevents future generation but does not delete prior Invoices;
- schedule change cannot regenerate already completed occurrence keys;
- seller/customer/requisite invalidation is surfaced as failed occurrence, not silent rerouting unless explicit fallback policy exists.

## Permissions

```text
recurring_invoice.create
recurring_invoice.read
recurring_invoice.update
recurring_invoice.activate
recurring_invoice.deactivate
```

Auto-issue execution uses an explicit service/business identity governed by policy and does not silently impersonate a user.

## Errors

```text
RECURRING_RULE_NOT_FOUND
RECURRING_RULE_INVALID
RECURRING_OCCURRENCE_DUPLICATE
RECURRING_OCCURRENCE_FAILED
RECURRING_SELLER_INVALID
RECURRING_CUSTOMER_INVALID
```

## Acceptance criteria

- each scheduled occurrence creates at most one Invoice;
- retry after worker failure does not duplicate result;
- Draft-only and auto-issue/send modes behave as configured;
- rule edits do not mutate prior Invoices;
- timezone/schedule calculations are deterministic;
- failed occurrence is visible and safely retryable.
