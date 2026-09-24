# Confirmed Design Decision Register

This file records the 90 decisions confirmed by the human partner. These decisions are authoritative within this pack unless a later explicit human decision changes them.

| Q | Topic | Confirmed decision |
|---:|---|---|
| 1 | Implementation scope | Backend + frontend. |
| 2 | Field engine scope | Generic field-capable entity engine. |
| 3 | Required fields | Supported system + custom fields. |
| 4 | Field types | TrueCRM catalog + FILE + ADDRESS. |
| 5 | Field code | Admin-provided or generated; immutable after creation. |
| 6 | Field permissions | Roles/users/departments/department tree via existing authorization. |
| 7 | Required enforcement timing | Stage entry and normal save while rule applies. |
| 8 | Specialist activity ownership | Activity layer delegates to Calendar/Tasks/Communication/Files. |
| 9 | Unbound activities | Allowed. |
| 10 | Activity lifecycle | PLANNED/IN_PROGRESS/COMPLETED/CANCELLED. |
| 11 | Custom activity types | Workspace-defined + provider/app-defined. |
| 12 | Timeline comment deletion | Editable + soft delete with audit. |
| 13 | Activity deletion | Soft delete/archive, preserve history. |
| 14 | Initial entity adapters | Lead/Contact/Company/Deal; generic registry for future entities. |
| 15 | Field-code uniqueness | Workspace + entity type. |
| 16 | Multiplicity | Compatible field types may be multiple. |
| 17 | Validation | Type-specific configurable constraints. |
| 18 | List option lifecycle | Stable option identity; used options deactivate. |
| 19 | Defaults | Static typed values only. |
| 20 | Field type change | Free before values; otherwise explicit migration. |
| 21 | Hard-delete field | Only unused, dependency-free fields. |
| 22 | Search/filter/sort | Admin-controlled supported capabilities. |
| 23 | External exposure | Independent Forms/Import/Export/API switches. |
| 24 | Permission conflicts | Record access first; field rule only narrows; most restrictive applies. |
| 25 | Requirement combination | Any applicable required rule makes field required. |
| 26 | Conditional requirements | Safe AND/OR declarative conditions. |
| 27 | Layout ownership | Sort/display flags only; no full layout designer. |
| 28 | Missing specialist dependencies | Adapters/contracts; generic Activities remain compilable. |
| 29 | Activity responsibility | One responsible + optional participants/watchers. |
| 30 | Activity time | Type-aware start/end/deadline. |
| 31 | Direction | INCOMING/OUTGOING/NOT_APPLICABLE. |
| 32 | Reminders | Multiple relative/absolute reminders with recipients. |
| 33 | Activity recurrence | No generic recurrence; Tasks/Calendar own it. |
| 34 | Completed editing | Reopen before business edits; comments/files may continue as allowed. |
| 35 | Cancel reason | Optional. |
| 36 | Multi-binding visibility | At least one authorized binding; redact unauthorized bindings. |
| 37 | Multi-binding editing | Activity edit separate from binding authorization. |
| 38 | Custom activity type config | Name/code/icon/color/defaults/enabled/custom fields. |
| 39 | Activity custom fields | Global or per custom Activity type. |
| 40 | Timeline granularity | Meaningful business events only. |
| 41 | Noisy timeline events | Exact dedupe + optional display grouping. |
| 42 | Timeline comments | Text + files + mentions. |
| 43 | Notifications | Assignment/reassignment/reminders/overdue/cancel/participant invitation/selected completion. |
| 44 | Overdue | Derived; scheduler emits exactly-once overdue event. |
| 45 | Frontend surfaces | Settings + CRM record + global Activities. |
| 46 | Record API custom fields | Dedicated `customFields` object keyed by immutable code. |
| 47 | Value storage | Typed generic value rows. |
| 48 | Validation response | Return all safe field-level errors. |
| 49 | Atomic record write | System + custom values commit together. |
| 50 | Conditional engine | Nested controlled AND/OR and type-aware operators. |
| 51 | Deactivate referenced field | Require dependency-impact resolution. |
| 52 | Schema concurrency | Optimistic version conflict. |
| 53 | Reordering | Dedicated atomic reorder command. |
| 54 | Activity participants | Internal participants separate from customer communications. |
| 55 | Historical communication | Store CRM reference + normalized value used. |
| 56 | Reminder recipients | Per reminder, selected from eligible users. |
| 57 | Completion result | Generic result + type-specific/custom outcome data. |
| 58 | Activity permissions | Granular permission keys. |
| 59 | Field admin permissions | Separate CUSTOM_FIELDS.MANAGE and REQUIRED_FIELDS.MANAGE. |
| 60 | Timeline pagination | Cursor-based chronological pagination. |
| 61 | New requirement over legacy data | Existing rows readable/incomplete; enforce on next save/transition. |
| 62 | Validation bypass | Normal API/Import/Forms/Automation cannot bypass; controlled migration/repair only. |
| 63 | Empty semantics | null/missing/whitespace/[] empty; 0/false valid. |
| 64 | Inactive references | Preserve and mark inactive; block new selection by default. |
| 65 | Hidden fields in API | Omit entirely. |
| 66 | Authorized schema | Return only active, relevant, viewable schema to normal clients. |
| 67 | Default timing | Create only when no explicit value supplied. |
| 68 | Reopen transitions | Completed->IN_PROGRESS, Cancelled->PLANNED. |
| 69 | Reopen reason | Optional. |
| 70 | Timeline activity events | Created/major reschedule/reassignment/completion/cancel/reopen. |
| 71 | Activity discussion | Use Timeline comments, optionally linked to Activity. |
| 72 | Provider communication | Create/update Activity representation + meaningful Timeline projection. |
| 73 | Meeting sync | Calendar owns scheduling. |
| 74 | Task sync | Tasks owns task lifecycle. |
| 75 | Realtime | Use shared realtime layer; REST remains authoritative. |
| 76 | Idempotency | Retry-sensitive mutations idempotent; PATCH uses versioning where appropriate. |
| 77 | Reminder concept | Not a standalone Activity type; use FOLLOW_UP for standalone reminder. |
| 78 | Field placement | showOnCreate/showOnEdit/showOnDetail/list-column flags + sort. |
| 79 | Priority | LOW/NORMAL/HIGH; default NORMAL. |
| 80 | Global Activities view | List + deadline board. |
| 81 | Default Activities landing | My Open Activities, overdue/urgent first. |
| 82 | Bulk actions | Reassign/complete/cancel/soft-delete. |
| 83 | Bulk failure semantics | Partial success with per-item outcome. |
| 84 | Timeline snapshot | Source refs + small sanitized presentation snapshot. |
| 85 | Activity retention | Restore/recycle; shared retention policy controls purge. |
| 86 | API structure | Locked `/api/v1/crm/...` route families. |
| 87 | Pagination strategy | Cursor for Activities/Timeline; page/limit for small admin lists. |
| 88 | Domain events | Stable envelope + IDs/actor/time/correlation + safe change summary. |
| 89 | Testing depth | Backend unit/integration/API/security + frontend interaction + key E2E. |
| 90 | Persistence implementation | Repository-first; Prisma fallback for new repo. |

## Decision handling rule

Do not reopen these decisions during implementation merely because another product, framework or existing codebase behaves differently. If the real repository cannot support a decision without a significant locked-business-behavior change, stop and ask the human partner rather than silently weakening the requirement.
