# Decision Register

Latest explicit decisions in this register override lower-priority source/reference conventions.

## Q1 — Implementation depth

Core implementation now; advanced Scrum/Flow, advanced booking/document collaboration can be phased without weakening core contracts.

## Q2 — Project/Workgroup model

One common projects container with type/mode and enabled tools.

## Q3 — Task status model

Fixed Task lifecycle distinct from configurable Project Kanban stages: PENDING, IN_PROGRESS, REVIEW, COMPLETED, DEFERRED, CANCELLED.

## Q4 — Completion control

Configurable per Task/template; normal tasks complete directly, controlled tasks require review.

## Q5 — Project visibility

Support private, workspace-visible/invite-only and open-to-join modes with separate membership and modification rights.

## Q6 — External Project participants

External people collaborate through Collabs, not ordinary Project membership.

## Q7 — Calendar types

Personal, Company, Department and Project Calendars.

## Q8 — External calendar sync

Google + Microsoft + ICS import/export through provider abstraction; future providers can be added.

## Q9 — Public booking

Public link booking; name/email required, phone/additional fields configurable.

## Q10 — External file storage

Internal object storage first; provider adapter architecture supports external storage later.

## Q11 — Document editing

Versioning + edit sessions/locks + external editing provider capability; no home-grown Google Docs clone.

## Q12 — Company Feed posting

Requires FEED.POST_WORKSPACE or equivalent permission; normal users limited to authorized audiences.

## Q13 — External Chat/Channel access

No normal external access; external collaboration occurs through Collabs.

## Q14 — Calls media

TrueCRM owns call state/permissions/history; provider/SFU adapter owns media transport.

## Q15 — Task discussion

System-managed Task Chat replaces a duplicate Task-comment subsystem.

## Q16 — Parent/subtask completion

Configurable IGNORE/WARN/REQUIRE_ALL; default WARN.

## Q17 — Project tool provisioning

Lazily provision one canonical Project Chat/Calendar/Drive when enabled; idempotent.

## Q18 — Archived Project

Operationally read-only and restorable; history remains readable by permission.

## Q19 — Department Calendar membership

Department membership drives default access; managers receive management capability subject to policy.

## Q20 — Booking confirmation

Per-page AUTO_CONFIRM or REQUIRE_APPROVAL; default AUTO_CONFIRM.

## Q21 — Calendar sync conflict

Detect concurrent changes, preserve conflict data and resolve deterministically/manually instead of silent overwrite.

## Q22 — Recycle retention

Workspace-configurable; default 30 days.

## Q23 — Public file editing

Anonymous public links are View/Download only in V1; edit requires authenticated/Collab access.

## Q24 — Same filename upload

No silent overwrite; explicit CREATE_VERSION, RENAME or CANCEL choice.

## Q25 — Quota exceeded

Block net-new binary/version growth; preserve read/download/delete/recovery actions that do not increase storage.

## Q26 — Document templates

DOCX and HTML template support with DOCX/PDF output as applicable.

## Q27 — Message edit/delete

Configurable sender window, default 24h; moderators may act later; preserve versions/tombstone/audit.

## Q28 — Read receipts

Exact receipts for smaller conversational contexts; aggregate/read-position for large broadcast contexts.

## Q29 — Message retention

Indefinite by default; Admin can configure scoped auto-retention; Legal Hold overrides purge.

## Q30 — Files on message deletion

Remove attachment binding only; File follows independent retention.

## Q31 — External call guest

May join a call by secure scoped link without Chat/Workspace access.

## Q32 — Create Task/Event from communication

Maintain durable source binding back to message/post.

## Q33 — Pagination

Page-based normal collections; stable cursor pagination for chronological/high-churn streams.

## Q34 — Concurrent editing

Optimistic concurrency; stale write returns 409 RESOURCE_VERSION_CONFLICT.

## Q35 — Idempotency

Required for retry-sensitive mutations, jobs, callbacks and recurrence; not every HTTP request.

## Q36 — Deletion model

Domain-specific lifecycle rather than one generic delete model.

## Q37 — Task Chat membership

Task access automatically controls Task Chat membership; no independent join bypass.

## Q38 — Project resource lifecycle

Archive makes linked resources read-only; destructive lifecycle follows each resource retention/history rules.

## Q39 — Feed audience evolution

Normal Feed dynamic; announcement/compliance audience snapshotted at publication.

## Q40 — Collab guest identity

Global User identity without ordinary Workspace membership; access through Collab membership only.

## Q41 — Central Audit granularity

Audit security/business-critical mutations; ordinary communication content is its own durable evidence.

## Q42 — Expensive operations

Normal CRUD synchronous; long operations use jobs and may return 202 with operation state.

## Q43 — Bots

Keep BOT actor/schema/event extension points; full bot/AI management deferred to later platform modules.

## Q44 — External REST API

Authorized API/service credentials use the same domain APIs and permission/tenant/entitlement checks.

## Q45 — Domain webhooks

Modules publish durable domain events; shared Integration/Webhook service delivers externally.

## Q46 — Notification defaults

Sensible defaults with user/channel preferences; mandatory security/compliance notices may be non-mutable.

## Q47 — Collab invitation expiry

Configurable, default 7 days; revocable, high-entropy, single-use acceptance token.

## Q48 — Permanent deletion authority

Dedicated purge/hard-delete permission required; retention/Legal Hold may still block.

## Q49 — Channel visibility

PUBLIC and PRIVATE; publishing role separate from subscriber/read access.

## Q50 — Upload size

Plan/workspace effective limit with platform ceiling; default 100 MB; 413 FILE_TOO_LARGE when exceeded.

## Q51 — Public File link expiry

Workspace policy controls maximum/mandatory expiry; default 30 days.
