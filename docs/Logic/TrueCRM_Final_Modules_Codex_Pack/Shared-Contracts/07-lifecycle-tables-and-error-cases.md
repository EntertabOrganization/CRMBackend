# Primary state machines and forbidden edges

| Aggregate | Allowed states and key transitions | Explicitly forbidden |
|---|---|---|
| Knowledge Article | DRAFT -> PUBLISHED -> new DRAFT, ARCHIVED, RECYCLED -> RESTORED; purge legal-hold gated | Publishing unapproved changed draft, AI indexing recycled article |
| Article Publication Request | PENDING -> APPROVED/REJECTED/CANCELLED; applies exact revision | Reusing approval for newer draft |
| AI run | QUEUED -> RUNNING -> WAITING_APPROVAL/SUCCEEDED/FAILED/CANCEL_REQUESTED -> CANCELLED or terminal | Duplicate paid run from same operation key |
| AI Tool | PROPOSED -> WAITING_APPROVAL -> EXECUTING -> SUCCEEDED/FAILED/DENIED | High-risk tool executed on Allow Always |
| Outbox/Job | PENDING/QUEUED -> RUNNING/RETRYING -> PUBLISHED/SUCCEEDED or DLQ; authorized replay | Unbounded retries / lost business truth on Redis wipe |
| SaaS subscription | FREE/TRIALING/PENDING_PAYMENT -> ACTIVE -> PAST_DUE/GRACE -> ACTIVE/EXPIRED, CANCEL_PENDING -> CANCELLED | Paid status from browser redirect or unverified webhook |
| Usage reservation | RESERVED -> SETTLED/RELEASED/EXPIRED with reconciliation | Negative quota / twice-consumed units |
| Partner Application | PENDING -> APPROVED/REJECTED | Two partner organizations from same approval |
| Partner Relation | PENDING -> ACTIVE -> ENDED | Two ACTIVE relations per Workspace |
| Partner Delegation | REQUESTED -> ACTIVE -> REVOKED/EXPIRED | Auto-regrant after reactivation |
| Commission | PENDING -> ELIGIBLE -> HELD/APPROVED -> PAID; reversal as ledger adjustment | Commission before settled revenue |
| Payout | DRAFT -> SUBMITTED -> APPROVED -> PROCESSING -> PAID/FAILED | PAID without finance approval and evidence |

State machine writes require expected version and locking; invalid edges return `409 INVALID_STATE_TRANSITION` without event/audit side effect. Audit records for *attempted unauthorized access* may be emitted as separate security events, never evidence a business write occurred. Retry status remains user-queryable.
