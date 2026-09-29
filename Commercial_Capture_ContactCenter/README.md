# TrueCRM Commercial, Capture & Contact Center — Codex Pack

> **Backend-only implementation scope:** This specification authorizes server-side work only: database schema and migrations, domain/application services, REST APIs, authorization, audit/outbox events, workers/jobs, provider adapters, and automated backend tests. Do not create, modify, scaffold, or test frontend pages, UI components, browser views, styling, or client-side application code. Any UI/browser wording below defines backend-facing behavior or security constraints only.


This pack is an implementation contract for four connected TrueCRM capability groups:

1. **Estimates, Invoices & Payments**
2. **CRM Forms & Capture**
3. **Contact Center & Channels**
4. **Company Details, Requisites & Bank Data**

## Start here

The coding agent must read:

```text
Agent.md
```

before changing the repository.

Then read `DECISIONS.md`, the module specification(s) for the requested goal, and all corresponding contract tests under `Testing/`.

A ready-to-paste autonomous execution prompt is included as:

```text
IMPLEMENTATION_PROMPT.md
```

## Structural philosophy

This pack follows the attached reference Codex Pack philosophy:

- one master execution contract;
- repository-first behavior;
- focused module specifications;
- executable contract tests that must be wired to the real repository;
- targeted tests plus a full regression suite;
- FINISHED only after implementation, review, repair and retest.

It does **not** copy the reference Auth module's business rules.

## TrueCRM architecture basis

The specifications follow the approved TrueCRM PRD, BRD and System Architecture:

- the repository's existing server-side TypeScript and `/api/v1` HTTP conventions;
- backend-only delivery; no frontend pages, components, styles, or client application changes;
- PostgreSQL source of truth;
- Workspace tenant isolation;
- transactional outbox for important domain changes;
- queues/workers for retryable/long work;
- immutable historical commercial/legal snapshots;
- provider adapters around external systems;
- backend-authoritative authorization.

The Bitrix24 REST documentation URL provided by the project is used only as a behavioral/reference source. The pack keeps useful conceptual separation while implementing the confirmed native TrueCRM design.

## Pack organization

```text
Agent.md
README.md
manifest.json
DECISIONS.md
REQUIREMENT_TRACEABILITY.md
IMPLEMENTATION_PROMPT.md

Estimates-Invoices-Payments/
CRM-Forms-Capture/
Contact-Center/
Company-Details-Requisites-Bank/
Testing/
```

## Implement one area

Example:

```text
Complete CRM Forms & Capture according to this pack.
```

The coding agent must implement all required behavior and directly necessary shared changes, wire the relevant tests, run them, review the implementation against the spec, fix failures or mismatches, rerun the tests, then run the complete regression suite.

## Implement the entire pack

Use the prompt in `IMPLEMENTATION_PROMPT.md` and set the goal to:

```text
Build the entire TrueCRM Commercial, Capture & Contact Center pack.
```

A sensible dependency order is:

1. Company Details / Requisites / Bank Data
2. Estimates
3. Invoices
4. Payments / Providers / Refunds / Recurrence
5. CRM Forms / Capture
6. Contact Center / Channels
7. Cross-module regression review

The coding agent may adjust implementation order after repository inspection when existing dependencies make another sequence safer.

## Executable tests

Files under `Testing/` are intentionally failing contract tests until wired to the actual repository.

They must not be deleted, skipped or weakened simply to make CI green. If the repository uses another test runner, translate them while preserving every required scenario.

## Reference sources

- TrueCRM Product Requirements Document
- TrueCRM Business Requirements Document
- TrueCRM System Architecture Document
- confirmed 60-question design interview
- provided Bitrix24 documentation entrypoint: `https://apidocs.bitrix24.com/`
- attached reference Codex Pack structure/testing philosophy
