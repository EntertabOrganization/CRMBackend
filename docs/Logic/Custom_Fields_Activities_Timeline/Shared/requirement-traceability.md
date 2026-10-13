# Requirement Traceability Matrix

## Purpose

Map major requirements to the specification file that owns implementation detail. This prevents important requirements from being lost across many Markdown files.

## Source-derived requirements

| Requirement | Primary source basis | Specification owner |
|---|---|---|
| TrueCRM is multi-tenant and every business record is workspace-scoped | PRD Overview; Architecture Overview | `Agent.md`, `Shared/authorization-security.md` |
| Dynamic custom fields avoid code deployment | PRD/BRD 05 | `Custom-Required-Fields/overview.md` |
| Supported field types include text/numbers/boolean/date/list/phone/email/URL/money/user/CRM references; FILE/ADDRESS added by confirmed decision | PRD/BRD 05 + Decision Q4 | `field-types-values.md` |
| Field defaults, multiplicity, options, active state, sort order | PRD 05 | `field-definitions.md`, `validation-options-lifecycle.md` |
| Field visibility/edit restrictions | PRD/BRD 05; Authorization architecture | `permissions-exposure.md` |
| Required fields by entity/pipeline/stage | PRD/BRD 04/05 | `required-fields.md` |
| Required validation is server-side | PRD/BRD 05 | `required-fields.md`, `Agent.md` |
| Deactivation preserves values | PRD/BRD/Architecture 05 | `validation-options-lifecycle.md` |
| Type changes require migration | PRD/BRD/Architecture 05 | `validation-options-lifecycle.md`, `migrations-retention.md` |
| Searchable/indexable settings | PRD 05 | `permissions-exposure.md` |
| Activities include calls, meetings, emails, messages, tasks, follow-ups, documents/custom activities | PRD/BRD 06 | `Activities-Timeline/overview.md` |
| Activity responsible/priority/direction/time/status/bindings/communications/files | PRD/BRD 06 | `activity-model.md`, `bindings-communications-reminders.md` |
| One Activity may bind to several CRM records | PRD/BRD/Architecture 06 | `bindings-communications-reminders.md` |
| Activity and Timeline are separate | PRD/BRD 06 | `Activities-Timeline/overview.md`, `timeline.md` |
| Timeline projects communication/document/automation/commercial events | PRD/BRD/Architecture 06 | `timeline.md` |
| Timeline deduplication/rebuildability | Architecture 06 | `timeline.md`, `domain-events-realtime.md` |
| Dates use timezone-safe real instants | PRD/Architecture 06 | `activity-model.md` |
| Shared platform outbox/jobs/realtime/search/audit | PRD/Architecture 30 | `Agent.md`, `domain-events-realtime.md` |

## Confirmed design-decision mapping

| Decision range | Topic | Primary specification files |
|---|---|---|
| Q1 | Backend + frontend | all module specs + frontend specs |
| Q2–Q7 | Field engine scope, system targets, types, code, permissions, enforcement | `overview.md`, `field-definitions.md`, `required-fields.md` |
| Q8–Q13 | Activity ownership/lifecycle/custom types/deletion/comments | Activities specs |
| Q14–Q27 | Field adapters, typed configuration, lifecycle, search/exposure, conditional rules, UI placement | all Custom-Required-Fields specs |
| Q28–Q45 | Activity adapters, participants, timing, reminders, bindings, timeline, notifications, frontend | all Activities-Timeline specs |
| Q46–Q60 | API shapes, typed value storage, validation responses, concurrency, Activity permission/query details | Custom/Activities API + Shared specs |
| Q61–Q76 | legacy data, bypass rules, empty semantics, hidden fields, lifecycle, provider sync, realtime/idempotency | Shared + lifecycle specs |
| Q77–Q90 | reminder semantics, activity views, retention, route structure, event envelopes, testing, ORM rule | README/Agent/API/frontend/testing specs |

For individual decision wording, see `Decision-Register.md`.

## External reference behavior used as inspiration

Official Bitrix24 REST documentation referenced by the project source informed product comparison for:

- custom field machine code/type/multiplicity/mandatory/sort/search/filter settings;
- system Activity fields such as responsible user, direction, priority, start/end/deadline, communications and files;
- Activity bindings to multiple CRM entities;
- separate Timeline comment create/update/delete APIs.

TrueCRM intentionally diverges where confirmed decisions require stronger behavior, including:

- richer Activity lifecycle;
- soft-deleted Timeline comments;
- generic typed custom value model;
- most-restrictive field permission semantics;
- declarative conditional requirements;
- dedicated multi-tenant authorization;
- derived Timeline with explicit source-event dedupe and rebuildability.

## Coverage gate

Before declaring implementation complete, verify every row above is implemented or explicitly marked not applicable because the owning dependency module does not yet exist. Dependency absence may justify an adapter fake/feature gate, not silent duplication or removal of the requirement.
