<!-- Module specifications and execution contract: docs/Logic/Custom_Fields_Activities_Timeline/; executable tests: tests/modules/Custom_Fields_Activities_Timeline/ -->

# Testing Coverage Matrix

| Area | Happy path | Invalid input | Auth / tenant | Concurrency / retry | Lifecycle / history | Frontend |
|---|---:|---:|---:|---:|---:|---:|
| Field definitions | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Typed values | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| List options | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Field permissions | ✓ | ✓ | ✓ | n/a | ✓ | ✓ |
| Required fields | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Conditional rules | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Type migration | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ admin |
| Activities | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Bindings | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Communications | ✓ | ✓ | ✓ | ✓ provider | ✓ | ✓ |
| Reminders/overdue | ✓ | ✓ | ✓ | ✓ exactly-once | ✓ | ✓ |
| Specialist adapters | ✓ fake/real | ✓ | ✓ | ✓ | ✓ | ✓ |
| Timeline projection | ✓ | ✓ | ✓ | ✓ dedupe | ✓ rebuild | ✓ |
| Timeline comments | ✓ | ✓ | ✓ | ✓ | ✓ soft-delete | ✓ |
| Bulk Activity actions | ✓ | ✓ | ✓ per-item | ✓ | ✓ | ✓ |
| Realtime | ✓ | ✓ | ✓ | ✓ dedupe/order | ✓ | ✓ |

## Mandatory security scenarios

- foreign workspace custom field ID rejected;
- foreign workspace option/reference/stage/pipeline ID rejected;
- hidden field omitted from record and schema APIs;
- read-only field write rejected even by direct API;
- Activity response redacts unauthorized bindings;
- Timeline cannot be opened without CRM-record access;
- mention does not grant CRM access;
- cross-workspace Activity binding/participant/reference rejected;
- API exposure flag does not bypass permission;
- ordinary Automation/Import/API path cannot bypass required rules.

## Mandatory retry/concurrency scenarios

- stale custom-field config update returns conflict;
- stale Activity update returns conflict;
- same Activity create idempotency key creates one logical Activity;
- same complete key creates one completion/timeline event;
- same provider event creates one Activity representation;
- duplicate source event creates one Timeline entry per intended CRM target;
- overdue worker retry emits one overdue occurrence;
- reminder worker retry emits one logical reminder occurrence;
- bulk root retry does not duplicate successful item effects.
