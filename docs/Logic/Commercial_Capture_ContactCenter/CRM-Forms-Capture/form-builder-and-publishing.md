# Form Builder and Publishing Specification

> **Backend-only implementation scope:** This specification authorizes server-side work only: database schema and migrations, domain/application services, REST APIs, authorization, audit/outbox events, workers/jobs, provider adapters, and automated backend tests. Do not create, modify, scaffold, or test frontend pages, UI components, browser views, styling, or client-side application code. Any UI/browser wording below defines backend-facing behavior or security constraints only.


## Goal

Implement draft editing, immutable published versions, pages, fields, mappings, conditional visibility and publish-time validation.

## Version model

Recommended logical structure:

```text
crm_forms                 logical identity/current pointers
crm_form_versions         immutable once PUBLISHED
crm_form_pages            belong to version
crm_form_fields           belong to version/page
crm_form_rules            belong to version
crm_form_agreements       referenced/versioned consent configuration
```

Version status:

```text
DRAFT | PUBLISHED | SUPERSEDED
```

Only DRAFT is mutable.

When an admin edits a published Form:
- clone/copy published configuration to a new DRAFT if no draft exists;
- edits affect draft only;
- public Form continues serving `publishedVersionId`;
- publish validates and atomically switches published pointer;
- previous published version becomes SUPERSEDED and remains readable for historical Submission interpretation.

## Fields

Each field defines applicable:

```text
key stable within version lineage
label
type
page/order
required
multiple
defaultValue
hidden
help/hint
crmMapping nullable
customField mapping nullable
validation rules
file constraints if FILE
agreement reference if CONSENT
```

Reuse TrueCRM custom-field/type infrastructure where possible. Supported families include text, textarea, integer/decimal, boolean, date/datetime, list/multi-list, phone, email, URL, money, file, consent and safe authenticated/internal reference types.

Public Forms must never expose fields forbidden for public input.

## Pages / multi-step

- at least one page;
- stable page/field ordering;
- server validates final payload, not just browser-visible state;
- conditional hidden fields cannot bypass required-field rules;
- page navigation state is presentation; final submitted schema truth remains server-side.

## Conditional rules

Rules are declarative and schema-validated. They may control field/page visibility and requirement where configured.

Do not allow arbitrary JavaScript, shell, SQL or tenant code.

Reject invalid references and dependency cycles where the rule model can cycle.

## CRM mapping

A Form field may map to allowed CRM/system/custom fields for a specific capture target.

Publish fails when mapping references:
- deleted/inactive target field;
- wrong entity type;
- incompatible type without explicit converter;
- forbidden target field;
- cross-Workspace metadata.

## Publish validation

```text
POST /api/v1/forms/:id/publish
```

Validate:
- caller permission;
- DRAFT version exists;
- valid page/field structure;
- unique field keys;
- valid conditional references;
- satisfiable required fields;
- valid CRM mappings;
- valid capture recipe/duplicate/assignment policies for CRM_CAPTURE;
- safe configured success redirect when REDIRECT;
- file limits within platform limits;
- agreement references/version configuration valid;
- access/security configuration valid.

Publishing is atomic. A broken draft never replaces current live version.

## Embed / public metadata

Expose safe public URL/embed metadata using the public key/slug only. Do not expose privileged IDs/secrets.

## Acceptance criteria

- editing live Form does not change current public schema until republished;
- prior Submissions remain interpretable through version link;
- publish rejects invalid mapping/rules/security config;
- concurrent publish/update cannot produce half-published schema;
- public client cannot submit fields outside published version;
- version history is auditable without changing prior Submissions.
