# Execution, Retry, Idempotency & Loop Protection

## Execution statuses

Use repository-equivalent explicit states such as:

```text
PENDING
RUNNING
SUCCEEDED
SUCCEEDED_WITH_ERRORS
FAILED_RETRYABLE
FAILED_FINAL
SKIPPED_CONDITION
SKIPPED_STALE
CANCELLED
```

Do not overload one boolean `success` for operational state.

## Execution record

Each Rule run records:

- Workspace;
- Rule + revision;
- trigger/event;
- target;
- initiating actor when any;
- execution identity;
- correlation/causation/depth;
- started/completed timestamps;
- result status;
- failure code/summary;
- retry metadata.

Each Action gets a child execution record with attempt details.

## Idempotency

Build stable keys from immutable execution identity, for example:

```text
ruleRevisionId + triggerEventId + targetId
```

Action side effects receive stable action execution/idempotency keys.

Provider/domain adapters must propagate idempotency where supported.

## Retry classification

Retry only failures explicitly classified as transient/retryable, e.g.:

- provider timeout;
- temporary connection error;
- rate limit when retry-after is available;
- worker crash before confirmation.

Do not automatically retry permanent business validation failures such as:

- permission denied;
- required field missing;
- invalid stage transition;
- unknown target;
- invalid configuration.

## Resume behavior

On execution retry:

- successful previous Actions remain successful;
- retry starts from the failed Action unless action semantics require a controlled replay;
- same idempotency keys prevent duplicate external effects.

## Loop/depth protection

Every Automation-generated domain mutation propagates correlation/causation metadata.

Configure platform-level maximum Automation depth and/or per-correlation Rule replay guard.

Detect examples:

```text
Rule A -> updates field X -> Rule B -> updates field Y -> Rule A ...
```

When limit/loop is detected:

- stop new side effects;
- mark execution with stable loop/depth error;
- make it visible in logs;
- do not hide it as success.

## Concurrency

Protect target-sensitive mutations using owning domain concurrency controls. Automation itself must not implement unsafe read-modify-write sequences around another module's rows.

## Acceptance criteria

- Duplicate delivery of same source event produces one business result per Rule revision/target.
- Retry after worker crash does not duplicate completed action.
- Permanent validation failure does not retry forever.
- Loop terminates at safety boundary with diagnostic log.
