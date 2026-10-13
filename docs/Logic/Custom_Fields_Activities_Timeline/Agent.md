# TrueCRM Custom Fields + Activities & Timeline — Agent Execution Contract

## Purpose

This pack is the implementation contract for the TrueCRM **Custom & Required Fields** and **Activities & Timeline** capability set.

A coding agent should be able to receive a goal such as:

```text
Complete Custom & Required Fields
Complete Activities & Timeline
Complete the entire TrueCRM Custom Fields + Activities pack
```

The agent must inspect the real repository first, read the relevant specifications in this pack, implement the requested scope completely, wire/adapt the contract tests, run them, fix failures, run the full regression suite, and only then report the scope as finished.

Do not stop after presenting a plan unless there is a genuine blocker that requires a human decision, an unavailable credential, or a repository conflict that changes a locked business decision.

---

## 1. Source-of-truth priority

When implementation details conflict, resolve them in this order:

1. latest explicit human decision in the active implementation conversation;
2. the 90 confirmed decisions captured in `Decision-Register.md`;
3. this pack's module specifications;
4. TrueCRM PRD / BRD / System Architecture;
5. existing repository behavior where it does not contradict the above;
6. Bitrix24 behavior used only as a product reference, never as an authority over TrueCRM decisions;
7. agent recommendation.

Do not invent requirements that contradict higher-priority sources.

---

## 2. Non-negotiable architecture

### Technology direction

- Frontend: Next.js + TypeScript.
- Backend: NestJS + TypeScript.
- Database: PostgreSQL is the transactional source of truth.
- Architecture: modular monolith with explicit domain-module boundaries.
- ORM/data access: repository-first. Use the repository's established solution. If a new repository has no established solution, prefer Prisma.
- Cache / ephemeral shared state: Redis where the existing platform uses it.
- Long-running work and timers: background jobs / queues.
- Files: shared Files/Documents module with object storage; do not copy binary storage into these modules.
- Realtime: shared WebSocket/SSE platform layer backed by durable database state.
- Search/index/timeline projections/counters/cache are derived and rebuildable.
- Important state changes use a transactional outbox in the same database commit as domain state.

### Tenant boundary

- `workspaceId` is the tenant boundary.
- Every field definition, field value, requirement rule, activity, binding, timeline entry, comment, type definition, reminder, and configuration row must be workspace-scoped directly or through a strongly validated parent.
- Never trust a client-supplied workspace ID for authorization.
- Resolve the active workspace from authenticated server context.
- Reject every cross-workspace relationship even if all referenced UUIDs are valid.

### Domain ownership

- CRM Core owns Lead, Contact, CRM Company, Deal and their physical/system fields.
- Custom Fields owns dynamic field definitions, options, values, visibility/edit restrictions and required-field rules.
- Pipelines owns stage transitions but calls the Required Fields contract before committing transitions.
- Activities owns the CRM-facing activity layer.
- Calendar owns Calendar Events / meeting scheduling lifecycle.
- Tasks owns Task lifecycle.
- Communication/Contact Center owns provider conversations/messages/call state.
- Files/Documents owns files/documents.
- Timeline is a derived CRM history/read model. It is not the business source of truth.
- Audit is append-only evidence and is separate from Timeline.

No module may directly manipulate another module's tables to bypass that module's business rules. Use application services/contracts/events.

---

## 3. Naming and database conventions

Prefer repository conventions when already established. Otherwise:

- TypeScript: `camelCase`.
- Types/classes: `PascalCase`.
- PostgreSQL: `snake_case`.
- IDs: UUID.
- Real instants: `timestamptz`.
- Date-only values: `date`.
- Money/precise decimals: `numeric` with explicit precision/scale appropriate to the repository standard.
- Every mutable configuration entity that needs optimistic concurrency has an integer `version` or repository-equivalent concurrency token.
- Functional timestamps such as `createdAt`, `updatedAt`, `completedAt`, `cancelledAt`, `occurredAt`, `deletedAt` are allowed and expected when useful; preserve existing repository standards.
- Soft-deletable records must have an explicit lifecycle marker compatible with repository conventions. Do not infer deletion from unrelated status fields.

Custom-field machine codes are immutable after creation. Human labels are mutable.

---

## 4. API conventions

Base prefix:

```text
/api/v1
```

Preferred success envelope unless repository conventions already define an equivalent:

```json
{
  "success": true,
  "data": {},
  "meta": null
}
```

Preferred error envelope:

```json
{
  "success": false,
  "error": {
    "code": "FIELD_VALIDATION_FAILED",
    "message": "One or more fields are invalid.",
    "details": {}
  },
  "requestId": "correlation-id"
}
```

Use stable machine-readable error codes. Do not return raw SQL/ORM/provider errors to clients.

### Pagination

- Activities and Timeline: cursor-based pagination.
- Small admin collections such as custom-field definitions, field options, requirement rules and activity types: page/limit pagination is acceptable.
- Maximum limits must be bounded.
- All filter/sort fields are allowlisted server-side.

### PUT/PATCH

- `PATCH` updates only supplied editable fields.
- If the repository uses `PUT`, it means full replacement of the editable state and requires all required editable fields.
- Never use PATCH to bypass required-field validation on a record that is subject to an active requirement rule.

---

## 5. Authorization model

Authentication never implies module authorization.

Every operation must evaluate:

1. authenticated user/service identity;
2. active workspace membership/service authorization;
3. module permission key;
4. normal resource scope such as Own, Department, Department Tree, Team or All/Workspace according to the existing TrueCRM authorization engine;
5. target record access;
6. activity-specific relationship rules where applicable;
7. field-level visibility/edit restrictions where applicable;
8. stage/resource state restrictions where applicable.

Field-level access may only reduce record-level access, never expand it.

A hidden field is omitted from normal record/schema responses to users who cannot view it. Do not return `null`, masked placeholders, field names, option labels, or metadata that reveals a restricted field.

Multi-bound Activities may be visible through at least one authorized binding, but unauthorized bindings must be removed from the response. Editing an Activity and editing its CRM bindings are separate authorization decisions.

---

## 6. Security rules

- Validate all identifiers and same-workspace relationships server-side.
- Treat custom-field values, form/import/API payloads, timeline comments, file references, communication values and provider events as untrusted input.
- Validate file IDs through the Files module and ensure caller access before binding them.
- Never allow arbitrary JavaScript, SQL or shell expressions in conditional required-field rules.
- Conditional rules use the declarative operator set defined in `Custom-Required-Fields/required-fields.md`.
- Normalize communication values through the appropriate platform/domain normalizer.
- Never expose unauthorized CRM record existence through Activity bindings, reference-field option endpoints, validation errors, search or timeline projections.
- Provider-originated events must be authenticated/verified by their owning integration and deduplicated using stable external IDs.
- Realtime messages do not grant access. The server rechecks current permission when delivering or when the client reloads.

---

## 7. Custom-field schema rules

- Core high-value system fields stay physical columns in owning domain tables.
- Dynamic fields use metadata + typed value storage.
- Do not add a database column per workspace custom field.
- Do not store all values as untyped JSONB.
- One custom-field value row populates the type-appropriate typed column(s) only.
- Multi-value fields use multiple ordered value rows.
- Custom field code uniqueness is per `workspace + entityType`.
- Type changes with existing values require explicit compatibility analysis and migration.
- Deactivation preserves historical values.
- Hard deletion is allowed only for never-used, dependency-free definitions that pass safety checks.
- Used list options are deactivated, not destructively deleted.

---

## 8. Required-field enforcement

Required-field validation is a domain rule, not a frontend rule.

Normal create/update/stage-transition requests from:

- UI;
- REST API;
- Forms;
- Import;
- Automation;
- internal module commands;

must use the same requirement resolver and field validation service.

Only an explicit internal migration/repair command may use a controlled bypass, and that bypass must be separately authorized, auditable and unavailable through normal public APIs.

Existing records made incomplete by a newly introduced requirement remain readable. The new rule is enforced on the next relevant normal save or stage transition.

---

## 9. Activities rules

Generic lifecycle:

```text
PLANNED -> IN_PROGRESS -> COMPLETED
                     \-> CANCELLED
COMPLETED -> IN_PROGRESS   (explicit reopen)
CANCELLED -> PLANNED       (explicit reopen)
```

- `OVERDUE` is derived, not a core lifecycle status.
- An overdue scheduler emits `ACTIVITY_OVERDUE` exactly once per applicable overdue occurrence.
- Completing an already-completed Activity is idempotent.
- Generic Activity recurrence is not implemented. Task recurrence belongs to Tasks. Meeting recurrence belongs to Calendar.
- A Reminder is not a standalone Activity type. Reminders are schedules attached to Activities. A standalone reminder use case is represented by `FOLLOW_UP`.
- Deletion is soft deletion/recycle behavior. Shared platform retention policy controls eventual eligible purge.

---

## 10. Specialist adapter rules

Do not duplicate specialist lifecycles.

### Meeting
- Calendar Event is authoritative for meeting scheduling.
- CRM edits delegate through a Calendar adapter/service.
- Activity reflects the confirmed Calendar outcome.

### Task
- Tasks module is authoritative for task status, recurrence, dependencies and completion.
- CRM Activity actions delegate through a Tasks adapter/service.

### Communication
- Email/Message/Call activities may be created/updated from Communication/Contact Center provider events.
- Store the CRM reference and normalized communication value used at the time.
- Stable external event IDs prevent duplicates.

### Documents
- File/document state remains owned by Files/Documents.
- Activities store references/bindings only.

If a specialist module is not yet implemented, define a narrow adapter contract and keep the generic Activity functionality compilable. Do not reimplement the specialist module inside Activities.

---

## 11. Timeline projection rules

- Timeline is a permission-aware derived chronological read model.
- Project meaningful business events, not every technical mutation.
- Preserve `sourceType`, `sourceId`, stable source event identity and projection version as appropriate.
- Exact duplicate source events must not create duplicate timeline entries.
- Timeline entries carry a small sanitized presentation snapshot, not the full source object.
- System-projected Timeline entries are immutable through user-facing APIs.
- User Timeline comments are editable/soft-deletable when authorized and may contain text, file references and mentions.
- Timeline must be rebuildable from durable sources/history/events where the platform has sufficient durable history.
- Audit remains the authoritative evidence for exhaustive changes.

---

## 12. Outbox, jobs, idempotency and concurrency

- Domain state and its required outbox event must commit atomically.
- Job retries must be safe.
- Use idempotency keys for retry-sensitive create/complete/cancel/reopen/comment/provider mutations where duplicate business effects are possible.
- Ordinary PATCH operations use optimistic concurrency where the resource exposes a version token.
- Configuration reorder operations are atomic.
- Bulk Activity actions support partial success; each item is reauthorized/revalidated independently.
- Never silently ignore a failed bulk item.

---

## 13. Realtime

Require realtime interface updates for:

- field schema changes;
- Activity create/update/reassign/complete/cancel/reopen/delete/restore;
- new Timeline projections;
- Timeline comment create/update/delete.

Realtime is advisory UI delivery only. Durable state remains in PostgreSQL and a page reload must recover the correct state.

---

## 14. Database and migration rules

Before changing schema:

1. inspect the repository's current schema and migrations;
2. inspect naming/mapping conventions;
3. never rewrite an already-applied migration;
4. add a new versioned migration;
5. include indexes/unique constraints/foreign keys required by these specifications;
6. validate same-workspace relationships at the service layer even when composite database constraints are impractical;
7. run format/schema validation/client generation as applicable;
8. run migration/database tests;
9. do not automatically execute production migrations.

Type-migration of existing custom-field business values is a separate controlled business operation from schema migration files. Do not silently cast production data during ordinary field-definition PATCH.

---

## 15. Audit requirements

Important mutations must create append-only audit evidence through the shared Audit service. At minimum audit:

- custom field create/update/activate/deactivate/hard-delete/type-migration;
- list option create/update/reorder/deactivate;
- field permission/exposure changes;
- required-field rule create/update/activate/deactivate;
- custom Activity type create/update/activate/deactivate;
- Activity create/update/reassign/complete/cancel/reopen/soft-delete/restore/binding changes;
- Timeline comment create/update/soft-delete;
- controlled validation bypass/migration operations.

Sanitize audit payloads. Do not store file binaries, provider secrets, or unrestricted snapshots of sensitive fields.

Audit must survive removal of the referenced business object according to platform retention rules.

---

## 16. Frontend execution rules

Implement the user-facing surfaces defined in the frontend specs using the repository's design system and routing conventions.

Required areas:

```text
Settings
├── Custom Fields
├── Required Fields
└── Activity Types

CRM Record
├── Activities / Things to do
└── Timeline

Global CRM
└── Activities
    ├── List
    └── Deadline Board
```

Rules:

- Never perform authorization solely in the client.
- Render fields from server-provided authorized schema.
- Show server validation errors at the appropriate field and summary level.
- Respect read-only/hidden state.
- Do not expose unauthorized bindings in cached client data.
- Reconcile realtime events with authoritative queries; prevent duplicate rendering.
- Preserve unsaved form state when feasible when a schema-invalidating event occurs; prompt/reload safely rather than silently losing user input.

---

## 17. Testing execution mode

`tests/modules/Custom_Fields_Activities_Timeline/` contains executable TypeScript/Jest-style contract tests. They intentionally fail until wired to the real repository.

For each requested module:

1. read this `Agent.md` fully;
2. read the matching specs;
3. inspect package scripts and test framework;
4. adapt contract tests to the existing Jest/Vitest/Playwright/Cypress/etc. convention rather than introducing duplicate frameworks without reason;
5. replace every `contract()` failure with real setup/assertions;
6. do not delete, skip, weaken or convert required tests to `todo` just to get green;
7. run unit/domain tests;
8. run database/integration tests;
9. run API E2E tests;
10. run authorization-negative and cross-workspace isolation tests;
11. run idempotency/concurrency tests;
12. run frontend component/interaction tests;
13. run key end-to-end user flows where the repository supports them;
14. run the full regression suite;
15. fix failures and repeat.

If an external specialist module is not available, test the adapter contract with deterministic fakes and clearly report the unperformed integration smoke test.

---

## 18. Definition of FINISHED

The agent may report a requested scope as `FINISHED` only when all applicable conditions are true:

- behavior in relevant specification files is implemented;
- repository conventions are respected;
- schema/migrations validate;
- TypeScript build passes;
- lint passes if configured;
- custom-field type/value validation tests pass;
- required/conditional requirement tests pass;
- field authorization/exposure tests pass;
- Activity lifecycle/binding/reminder/overdue tests pass;
- Timeline projection/dedupe/comment/pagination tests pass;
- cross-workspace tests pass;
- idempotency/concurrency tests pass;
- frontend tests pass for implemented surfaces;
- adapter tests pass;
- full regression suite passes;
- no required test has been disabled;
- no unrelated refactor is included;
- final diff has been reviewed for scope/security/data migration risk.

Final report must include:

1. implemented scope;
2. database/schema/migration changes;
3. API routes and DTOs added/changed;
4. permission keys added/used;
5. domain/audit events added;
6. adapters implemented or left mocked because dependencies are unavailable;
7. tests executed and exact results;
8. remaining manual smoke tests;
9. any repository-specific deviations from this pack and why they preserve the locked business behavior.

---

## 19. Git behavior

- Do not commit secrets or local environment credentials.
- Do not rewrite unrelated history.
- Keep changes scoped to the requested implementation plus directly required shared infrastructure.
- Prefer coherent commits if the human requests commits.
- Never force-push unless explicitly instructed.
- Do not claim work is committed/pushed unless the operation was actually performed.
