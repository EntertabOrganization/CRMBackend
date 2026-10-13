# TrueCRM Work Collaboration Modules — Agent Execution Contract

## Purpose

This is the MASTER EXECUTION CONTRACT for implementing the TrueCRM collaboration/work-management capabilities covered by this pack:

- Tasks & Projects
- Calendar & Meetings
- Files, Drive & Documents
- Feed, Chat & Internal Communication

A coding agent must read this file first, then the relevant module specification(s), then inspect the real repository before editing. The pack defines business behavior and testable contracts; the repository determines concrete file locations and existing implementation conventions.

The human partner should be able to request goals such as:

```text
Complete Tasks & Projects
Complete Calendar & Meetings
Complete Files, Drive & Documents
Complete Feed, Chat & Internal Communication
Complete the TrueCRM Collaboration Pack
```

The agent must implement the requested goal, adapt and wire the executable contracts under `tests/modules/Tasks&Calendar&Files&Chats/`, run targeted and regression tests, fix failures, and only then report the requested goal as FINISHED.

Do not stop after presenting a plan unless there is a genuine blocker that requires a human decision or an unavailable external credential.

---

## 1. Non-negotiable architecture

### Technology and deployment direction

- Frontend: Next.js + React + TypeScript.
- Backend: NestJS + TypeScript modular monolith.
- PostgreSQL is the authoritative business source of truth.
- Use the repository's established ORM/data-access layer; prefer Prisma only if the repository already uses it or no contrary repository convention exists.
- Redis is for cache, presence, typing, realtime fanout coordination, temporary counters and rate limits; it is not the durable business record.
- Object storage holds file binaries; PostgreSQL owns file metadata, logical relationships, permissions, versions and lifecycle state.
- Queues/workers execute long-running, retryable and scheduled operations.
- Realtime delivery happens after durable commit. A missed WebSocket/SSE event must be recoverable by normal API reload.
- External providers are hidden behind adapters so Google/Microsoft/media/editing/storage providers do not leak into domain logic.
- Start as a modular monolith. Cross-module writes go through application/domain services, not another module's tables.

### Tenant model

- Workspace is the tenant boundary and is not a CRM Company record.
- Every business row is workspace-scoped directly or through a strongly validated parent.
- Resolve one active Workspace context per authenticated request.
- Never trust a client-supplied `workspaceId` as authorization.
- Cross-Workspace IDs must behave as inaccessible even if they are valid UUIDs.
- A global User may belong to multiple Workspaces.
- A Collab external guest may have a global User identity without normal Workspace membership.

### Authorization model

Authentication and authorization are separate.

Effective authorization evaluates, as applicable:

```text
active workspace membership
+ permission action
+ permission scope
+ department/team relationship
+ project/task contextual role
+ direct resource membership
+ explicit resource ACL/inheritance
+ feature entitlement
+ resource state
```

Supported platform scopes include:

```text
OWN
DEPARTMENT
DEPARTMENT_TREE
TEAM
PUBLIC
ALL
```

The backend is authoritative. Hiding a UI button is never sufficient authorization.

### Naming

- TypeScript fields: `camelCase`.
- PostgreSQL tables/columns: `snake_case` via the repository's mapping convention.
- IDs: UUID unless the existing repository standard proves otherwise.
- Real instants: timezone-aware/timestamptz semantics.
- Date-only/all-day values: date semantics, never accidental midnight UTC timestamps.
- Money/precise numeric data, if introduced by a dependent feature, uses precise numeric types rather than floating point.

---

## 2. API conventions

Base prefix:

```text
/api/v1
```

Successful single-resource response:

```json
{
  "success": true,
  "data": {},
  "meta": null
}
```

Successful page-based collection response:

```json
{
  "success": true,
  "data": [],
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 0,
    "totalPages": 0
  }
}
```

Cursor response:

```json
{
  "success": true,
  "data": [],
  "meta": {
    "nextCursor": null,
    "hasMore": false
  }
}
```

Error response:

```json
{
  "success": false,
  "error": {
    "code": "PERMISSION_DENIED",
    "message": "Human-readable explanation.",
    "details": null
  },
  "requestId": "correlation-id"
}
```

Use stable machine-readable codes. Do not expose stack traces, provider secrets, object-storage paths, raw public-link secrets after creation, OAuth tokens or internal SQL details.

### PUT vs PATCH

- `PUT` replaces the complete editable state and requires all required editable fields.
- `PATCH` changes only supplied fields.
- Specialized state transitions use explicit action endpoints instead of abusing PATCH.

### Pagination

Use page-based pagination for ordinary administrative/resource lists:

```text
page=1
limit=20
max limit=100
search
sortBy
sortOrder
filters
```

Use cursor pagination for chronological/high-churn streams such as:

- Chat messages
- Feed stream
- Channel posts/comments where high churn makes offset pagination unstable

Cursor ordering must be deterministic using `(timestamp, id)` or an equivalent stable compound key.

### Filters

Reusable filter operators:

```text
eq neq in notIn contains startsWith endsWith gt gte lt lte isNull
```

Each endpoint explicitly whitelists searchable/filterable/sortable fields. Never expose arbitrary ORM property names or raw SQL fragments.

---

## 3. Concurrency and idempotency

### Optimistic concurrency

Mutable aggregates that can reasonably be edited concurrently carry a numeric `version` or repository-equivalent revision.

A stale write must fail with:

```text
409 RESOURCE_VERSION_CONFLICT
```

Do not silently last-write-wins over a newer Task, Project, Event, File metadata record, Booking configuration, Channel configuration or similar shared aggregate.

File content revisioning additionally uses immutable File Versions.

### Idempotency

Use idempotency for mutations where safe retries could duplicate effects, including:

- integration/automation-driven Task creation
- recurrence execution
- public Booking creation
- message send via `clientMessageId`
- upload completion
- generated document creation
- provider callbacks
- calendar synchronization commands
- retryable jobs/outbox consumers

Exactly-once business effect is achieved through durable dedupe keys/unique constraints and transactions, not by assuming workers run once.

---

## 4. Domain boundaries

### Tasks & Projects owns

Projects/workgroups, project members/tool configuration/stages, Tasks, task contextual membership, checklists, dependencies, time entries, completion reviews/results, task templates, recurrence rules/instances, Task history and Task/CRM bindings.

It does not own durable Chat messages, Files, Calendar Events, Notifications, Search, Audit or provider sync credentials.

### Calendar & Meetings owns

Calendars, calendar permissions/preferences, Events/Meetings, attendees/guests, recurrence, reminders, free/busy read models, resources/bookings, public booking pages/bookings and external calendar mappings/conflicts.

A Task deadline or Project milestone projected into Calendar does not become a duplicate Event.

### Files, Drive & Documents owns

Storages, folders, logical Files, immutable File Versions, upload sessions, derivatives/processing, File ACLs/inheritance, public links, locks/edit sessions, generic attachments, templates and generated documents.

It does not own the business record to which a File is attached.

### Communication owns

Feed posts, audiences/comments/interactions, Chats, membership sources, Messages/versions/read state, Channels/posts/discussions, Collabs, Calls and communication bindings.

Customer Contact Center/Open Channel conversations are outside this module.

---

## 5. Cross-module resource rules

- A Project may lazily provision one canonical Project Chat, Project Calendar and Project Drive. Provisioning is idempotent.
- A Task has one system-managed Task Chat. Task access controls Task Chat access; users cannot bypass Task permissions by joining its Chat independently.
- File attachments are references to one logical File, not copied binaries.
- File permission and attached-record permission may both restrict access.
- Creating a Task/Event from a message/post stores a durable binding back to the source content.
- Project archive makes project-owned collaborative resources operationally read-only; it does not blindly destroy history or file versions.
- External users collaborate through Collabs, not ordinary internal Projects/Chats/Channels.

---

## 6. Lifecycle and deletion

Do not force one deletion model on every domain.

### Task / Project

```text
active -> soft deleted -> restored OR authorized hard delete
```

Hard delete requires explicit permission and may be blocked by retention/legal/history constraints. Audit history survives.

### Calendar Event

Normal business removal is cancellation. Administrative deletion is separately permissioned and must preserve required historical/audit evidence.

### File / Folder

```text
active -> recycle bin -> restore OR retention purge
```

Default recycle retention: 30 days, workspace-configurable.

### Chat Message

Sender/moderator deletion creates a tombstone. Retention policy may later purge eligible content. Legal Hold blocks purge.

### Feed Post

Soft delete/restore and authorized purge where supported.

### Audit

Audit evidence is append-only and never removed by normal resource deletion.

---

## 7. Time, recurrence and scheduling

- Store real instants with timezone-aware semantics.
- Store all-day Event start/end as date semantics.
- Store recurrence source timezone using an IANA timezone identifier.
- Recurrence scheduler must be idempotent and create each scheduled Task/Event instance at most once.
- Booking finalization transactionally re-checks attendee/resource availability.
- Resource exclusivity is enforced at write time, not only through UI availability previews.
- Free/busy reveals availability intervals, not private Event details.

---

## 8. Files and untrusted content security

- Default maximum single upload: 100 MB, subject to effective plan/workspace configuration and platform ceiling.
- Return `413 FILE_TOO_LARGE` when a File exceeds the effective single-file limit.
- Storage quota and single-file size limits are distinct.
- Untrusted uploads remain quarantined until required validation/scanning succeeds.
- Blocked/infected content cannot be previewed/downloaded by normal users.
- Never expose raw object-storage bucket keys as application download URLs.
- Private downloads use short-lived signed URLs or controlled proxy delivery after authorization.
- Public File/Folder links use high-entropy secrets and store a hash rather than the raw secret where possible.
- Public-link default expiry is 30 days; workspace policy may require shorter or allow configured maximums.
- Public V1 links allow View/Download, not anonymous edit.
- External edit requires authenticated/Collab-authorized access.
- Same-name upload never silently overwrites. Caller explicitly chooses create version, rename or cancel.
- Old File Versions are immutable. Restoring an old version creates a new latest Version.
- Search must not reveal unauthorized filenames, previews or extracted text.
- URL metadata/link-preview fetchers must be protected against SSRF.

---

## 9. Communication durability and realtime

- Persist Message/Post first; commit DB/outbox; then fan out realtime.
- `clientMessageId` dedupes retries.
- Presence and typing are ephemeral and may be lost without losing business content.
- Membership can have multiple sources. Remove active access only when all access sources are gone.
- Historical membership rows are retained when needed to explain authorship/history.
- Message edit/delete windows default to 24 hours for senders; authorized moderators may act later according to permission.
- Message edits retain Message Version history.
- Direct/smaller Chats may maintain exact read receipts; large Channels/Feed use aggregate/read-position models where appropriate.
- Message retention defaults to indefinite. Admin policies may set retention by Workspace/Chat/Channel/Collab/Department.
- Legal Hold suspends applicable automated deletion.
- Message retention does not implicitly delete shared Files.

---

## 10. Public and external access

Public endpoints are narrow capabilities, not a bypass around normal authorization.

### Booking public access

- Public booking link/token is unguessable and rate-limited.
- Name/email are required for public guest booking; phone and additional fields are configurable.
- Booking pages may use `AUTO_CONFIRM` or `REQUIRE_APPROVAL`; default `AUTO_CONFIRM`.
- Final availability is revalidated transactionally.
- Cancellation/reschedule uses a signed scoped token.
- Public APIs reveal no private Event titles or employee directory data beyond page configuration.

### Collab invitations

- Default unused invitation expiry: 7 days, configurable.
- Token is high entropy, revocable and single-use once accepted.
- Resend creates a new token and invalidates the previous token.
- Collab membership grants only Collab-authorized resources.

### External service/API credentials

Authorized service/API credentials use the same domain permission, Workspace and entitlement checks as ordinary application calls. Do not create a weaker privileged integration API.

---

## 11. Events, outbox, jobs and webhooks

Important state changes write domain state plus an outbox row in the same transaction.

Consumers may update:

```text
Notifications
Search
Realtime
Analytics
Automation
Webhook delivery
AI indexing later
```

Modules publish domain events. The shared Integration/Webhook service owns signing, delivery attempts, retry, backoff and endpoint configuration.

Long operations use jobs and may return `202 Accepted`, including:

- malware scanning
- preview/thumbnail/text extraction
- large document generation
- calendar provider synchronization
- recursive folder operations
- retention purge
- large recurrence/backfill operations

Jobs use retry policy, idempotency, visible failure state and dead-letter handling where applicable.

---

## 12. Notification rules

Use shared platform Notifications and preferences.

Default notification-worthy events include:

- Task assignment/reassignment, approaching/overdue deadline, completion review
- Project membership changes
- Calendar invitation/change/cancellation/reminder
- Booking creation/reschedule/cancellation
- explicit File sharing and selected security-sensitive File events
- direct Chat activity according to user preferences
- mentions/replies
- required announcements
- Collab invitations

Routine reactions and read receipts do not create noisy notifications by default.

Mandatory security/compliance notifications may be non-mutable where policy requires.

---

## 13. Audit rules

Use centralized append-only Audit/Security events for important changes, including:

- permission and ACL changes
- Project membership/ownership changes
- public File link create/update/revoke/access-sensitive events
- File permission changes and purge
- moderator/admin communication deletion
- retention-policy and Legal Hold changes
- external Collab guest changes
- Calendar sync connection/conflict/security changes
- Booking administration
- generated business documents and destructive document actions where material

Do not duplicate every ordinary Chat Message/read into central Audit; durable communication/history tables are source evidence for ordinary content.

Critical mutation + Audit/Outbox records must be transactionally consistent where applicable.

Never store usable secrets in Audit payloads.

---

## 14. Repository-first execution rules

Before editing:

1. Read this file completely.
2. Read the relevant domain overview and child specs.
3. Read the matching `tests/modules/Tasks&Calendar&Files&Chats/` contracts.
4. Inspect `package.json` and existing scripts.
5. Inspect NestJS module/controller/service conventions.
6. Inspect ORM/schema/migrations and existing database naming.
7. Inspect guards/decorators/policy engine and Workspace context handling.
8. Inspect outbox/jobs/realtime/notification/file-provider patterns already present.
9. Inspect test framework, factories and fixtures.
10. Reuse repository dependencies and conventions where they preserve the locked behavior.

Do not invent repository state.

If repository details differ from this pack but behavior can remain identical, adapt implementation details to the repository. If repository behavior conflicts with a locked product/security decision, stop and ask the human partner rather than silently changing the contract.

---

## 15. Database and migrations

- Never rewrite an applied migration.
- Generate forward migrations for schema changes.
- Use database constraints and unique indexes for invariants that must survive race conditions.
- Validate same-Workspace foreign relationships.
- Avoid destructive cascade rules that erase required history/Audit.
- Use JSON/JSONB only for genuinely flexible provider/configuration payloads; do not hide normal relational domain fields inside JSON.
- Add indexes for common Workspace + status/owner/date lookups and chronological streams.
- Production migration execution is an explicit deployment activity; do not run it automatically without instruction.

---

## 16. Testing execution mode

`tests/modules/Tasks&Calendar&Files&Chats/` contains executable Jest-style contract files that intentionally fail until wired to the actual repository.

For each requested spec:

1. Adapt imports/setup to the repository.
2. Replace each `contract()` failure with real assertions.
3. Do not delete, skip, weaken or convert required tests to `todo` merely to get green output.
4. Test happy paths.
5. Test validation and stable error codes.
6. Test permission failures.
7. Test cross-Workspace isolation.
8. Test optimistic concurrency where applicable.
9. Test lifecycle transitions.
10. Test transaction rollback/outbox consistency.
11. Test idempotent retry behavior.
12. Test public-token abuse boundaries.
13. Test integration/provider failure behavior with deterministic mocks.
14. Run targeted tests until green.
15. Run the complete existing repository regression suite.

If the repository uses Vitest or another established runner, translate the contracts to that runner instead of adding a second testing framework.

External providers must be abstracted and mocked/faked in automated tests. Do not claim real Google/Microsoft/media-provider delivery if only a fake was exercised.

---

## 17. Definition of FINISHED

The agent may report `<Module> — FINISHED` only if all applicable conditions are true:

- requested behavior implemented completely
- repository conventions respected
- database/schema validation passes
- migrations generated/validated where needed
- TypeScript build passes
- lint passes if configured
- unit/service tests pass
- database/integration tests pass
- API E2E tests pass
- authorization-negative tests pass
- cross-Workspace isolation tests pass
- concurrency tests pass where applicable
- idempotency tests pass where applicable
- lifecycle/retention/legal-hold tests pass where applicable
- outbox/Audit tests pass for critical mutations
- provider failure/retry tests pass where applicable
- public access/security tests pass where applicable
- full repository regression suite passes
- no unrelated refactor remains
- final diff reviewed for scope

Final report must state:

1. What was implemented.
2. Database/schema/migration changes.
3. Controllers/routes/services affected.
4. Permission keys added/used.
5. Domain/Audit events added.
6. Jobs/provider adapters added/changed.
7. Tests executed and exact results.
8. Manual smoke tests still required.
9. Known limitations/blockers.
10. Necessary cross-module changes.

Never claim a test or provider integration was exercised when it was not.

---

## 18. Git behavior

Default:

- no commit
- no push
- no pull request

Only perform Git publication actions when explicitly requested by the human partner. Never hide unrelated changes inside the requested implementation.
