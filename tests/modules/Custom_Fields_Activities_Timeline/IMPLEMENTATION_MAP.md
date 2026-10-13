<!-- Module specifications and execution contract: docs/Logic/Custom_Fields_Activities_Timeline/; executable tests: tests/modules/Custom_Fields_Activities_Timeline/ -->

# Where each contract scenario is implemented

The preserved contract files in this directory still contain fail-closed `contract()` stubs and are now discovered by Jest. The table below maps their scenarios to existing implemented tests; it does not mean the original stubs are wired or passing.

Backend (Jest, `npm test` in `CRMBackend`; the `api-endpoints.spec.ts` cases run against the real local Postgres):

| Contract scenario (pack) | Implemented in |
|---|---|
| Custom fields: create field then create/update Deal with customFields atomically | `custom-fields.spec.ts` "writes the record and its custom values atomically"; `api-endpoints.spec.ts` Custom fields API |
| all safe field-level validation errors in one response | `custom-fields.spec.ts` "validates every supported type with stable field errors" |
| hidden fields omitted from schema and record responses | `custom-fields.spec.ts` "omits hidden fields from record and schema responses…" |
| direct write to read-only field rejected | `custom-fields.spec.ts` "rejects direct writes to a visible read-only field…" |
| foreign-workspace field/option/reference/stage ids rejected | `custom-fields.spec.ts` "rejects foreign-workspace field ids/options/references/stages…" and "rejects cross-workspace user, CRM and file references" |
| atomic reorder + schema version | `custom-fields.spec.ts` "atomically reorders fields, bumps the schema version…" |
| 0/false present, whitespace/empty array empty | `required-fields.spec.ts` "treats 0 and false as present…" |
| deactivate a used list option / reject inactive option on new write | `custom-fields.spec.ts` "deactivates a used list option without corrupting stored values, and rejects new selection of it" |
| stage/pipeline rules before transition and on later saves | `required-fields.spec.ts` "enforces target pipeline/stage rules before a stage transition commits, and on later saves in that stage" |
| unsupported operators / invalid typed constants at config time | `required-fields.spec.ts` "rejects unsupported operators and invalid typed condition constants at configuration time" |
| Activity with custom fields, bindings, communication, participants and reminders | `activities.spec.ts` (create + lifecycle), `activity-bindings-reminders.spec.ts`, `api-endpoints.spec.ts` Activities API |
| stale Activity PATCH conflict | `activities.spec.ts` "returns a version conflict for a stale Activity PATCH and writes nothing" |
| cross-workspace bindings/participants/references | `activities.spec.ts` "rejects cross-workspace bindings, participants, responsible users and reads" |
| Meeting -> Calendar, Task -> Tasks adapters | `activity-adapters.spec.ts` (Calendar/Tasks delegation, rejection, unregistered fallback) |
| completed Activity read-only without reopen | `activities.spec.ts` "rejects editing completed business fields without reopen, but still allows adding files" |
| type-aware start/end/deadline, timezone semantics | `activities.spec.ts` "validates type-aware start/end/deadline with timezone-explicit instants" |
| Activity with no binding | `activities.spec.ts` "allows an Activity with no CRM binding and adds a binding later" |
| soft delete/restore keeps history | `activities.spec.ts` "soft deletes and restores an Activity without erasing timeline or audit history" |
| overdue exactly once per deadline occurrence | `activity-bindings-reminders.spec.ts` "emits ACTIVITY_OVERDUE exactly once per deadline occurrence and again after a legitimate reschedule" |
| timeline only for authorized CRM records | `timeline.spec.ts` "applies current authorization at read time and never discloses unreadable sources"; `api-endpoints.spec.ts` Timeline API |
| cursor pagination with equal timestamps | `timeline.spec.ts` "orders by occurredAt plus a stable tie-breaker and paginates without gaps or repeats" |
| allow-listed filters | `timeline.spec.ts` "filters by category/actor/date/source type using allow-listed query fields" |
| outbox event delivered twice -> one entry | `timeline.spec.ts` "deduplicates repeated source events using a stable source event key" |
| comment with mentions and files; soft delete keeps evidence | `timeline.spec.ts` "creates/edits/soft-deletes comments with files and mentions" |
| historical projection survives binding removal | `timeline.spec.ts` "keeps the historical projection when a current Activity binding is later removed" |

Frontend (Vitest + Testing Library in `crm-frontend/tests/`): every scenario of `Testing/Frontend/custom-fields.ui.spec.ts`
is in `custom-fields.ui.test.tsx` and every scenario of `Testing/Frontend/activities-timeline.ui.spec.ts` is in
`activities-timeline.ui.test.tsx`, under the same titles.

Not performed (no real specialist module exists yet): Calendar/Tasks/Files/notification integration smoke tests. The
adapter contracts are covered with deterministic fakes (`FakeCalendarPort`, `FakeTaskPort`, `InMemoryFilePort`).
