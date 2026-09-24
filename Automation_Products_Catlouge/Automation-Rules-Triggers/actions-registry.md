# Automation Action Registry

## Goal

Expose controlled business operations that Automation can invoke without owning another module's persistence.

## Built-in action families

Register actions only when their owner module is available. Expected families include:

### CRM
- update allowed field(s);
- set responsible/owner where permitted;
- create registered CRM record;
- move pipeline/stage through StageTransitionService.

### Activities / Tasks
- create Activity;
- create Task.

### Notifications / Communication
- notify user(s);
- send through configured email/message channel.

### Documents / Integrations
- generate document through Documents service;
- call configured webhook/HTTP action through safe integration infrastructure.

The registry may later expose Product/Invoice/etc. operations when those domains register them.

## Action definition contract

Each action type defines:

- stable `actionCode`;
- display name/category;
- supported target types;
- typed configuration schema;
- runtime input resolver;
- permission/capability requirements;
- handler/adapter;
- timeout policy;
- retry classification;
- idempotency strategy;
- dry-run validator/preview;
- safe result schema.

## Ordered execution

Actions have explicit order/position.

Default execution:

```text
A1 success -> A2 success -> A3 fails -> stop
```

Persist each action attempt/result.

On safe retry, do not rerun already-confirmed successful actions unless the specific action contract explicitly says replay is safe and uses the same idempotency key.

## `continueOnError`

Optional per action. When true:

- persist failure;
- continue to next action;
- overall execution status must communicate partial failure, not falsely report full success.

## Domain authorization

An action handler calls the owning service with explicit execution context. The owner module performs final permission, state and validation checks.

Automation cannot bypass Required Fields, stage validation, file permissions, channel policy, etc.

## External HTTP/webhook action

Must use controlled integration infrastructure:

- allow protocol/host policies as defined by platform security;
- secrets from secure credential store;
- connection and total timeout;
- response size limit;
- retry only safe/transient failures;
- idempotency header/key where configured;
- redact secrets in logs;
- prevent SSRF against internal/private metadata/network targets according to platform policy.

## Custom Action extensions

Applications may register additional action definitions. Treat extension output as untrusted/typed data. Extensions receive scoped inputs and never raw database access.

## Acceptance criteria

- Actions execute in order.
- Failure semantics match configuration.
- Retry does not duplicate prior successful side effects.
- Owner-domain validation remains effective.
- Unknown/disabled action types make a Rule unpublishable or non-executable with a clear status.
