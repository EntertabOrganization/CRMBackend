# Automation Scheduling & Jobs

## Timing modes

Support:

- immediate;
- fixed delay after trigger;
- scheduled date/time;
- relative to an allowed target date/datetime field.

Do not implement durable human waits/parallel process state here; use Workflows for that.

## Time model

- real instants use timezone-safe timestamps (`timestamptz` or repository equivalent);
- relative-to-field scheduling respects the field semantics and Workspace/user timezone policy;
- store sufficient source timezone/context when a business-local time must be reproduced.

## Job creation

When a Rule matches and requires asynchronous execution, create a durable job containing at least:

- workspace ID;
- Rule ID and immutable Rule revision ID;
- target type/ID;
- trigger/event ID;
- scheduled time;
- status;
- attempts/max attempts;
- correlation/causation/depth;
- idempotency/dedupe key;
- execution identity policy reference;
- immutable trigger context snapshot needed for evaluation.

Do not copy full target records into jobs.

## Stale-state recheck

Immediately before side effects for delayed/scheduled jobs:

1. load Rule operational state;
2. load authoritative target within Workspace;
3. check target still exists/is actionable;
4. re-evaluate current-state conditions;
5. re-check execution permission/policy;
6. if invalid, mark `SKIPPED_STALE`/repository-equivalent with reason;
7. otherwise execute.

Do not silently drop skipped jobs.

## Cancellation

Authorized users may cancel pending jobs where no business side effect has begun. Cancellation is auditable.

An already-running action follows action-specific cancellation support; do not claim cancellation of an irreversible external side effect.

## Scheduler reliability

- database is durable truth for pending work or queue state is recoverable from durable job records;
- worker crashes must not lose jobs;
- dequeue/lease semantics prevent concurrent duplicate execution;
- retries use backoff according to shared job policy;
- dead-letter/final failure is visible.

## Acceptance criteria

- Scheduled job survives API/worker restart.
- Same matching event cannot create duplicate equivalent jobs.
- Delayed job uses pinned Rule revision.
- Stale target state prevents invalid action.
- Cancellation prevents not-yet-started side effects.
