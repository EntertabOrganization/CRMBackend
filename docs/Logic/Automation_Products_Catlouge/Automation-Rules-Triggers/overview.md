# Automation Rules & Triggers — Overview

## Goal

Provide configurable lightweight CRM/process automation driven by domain events, stage context and schedules without requiring code changes for every business rule.

Automation reduces repetitive work while preserving normal TrueCRM permissions, validation, domain ownership, idempotency and observability.

## Scope

Included:

- Rule CRUD and lifecycle;
- immutable published revisions;
- target registration;
- built-in and registered custom Triggers;
- declarative condition trees;
- ordered Actions;
- immediate, delayed, scheduled and relative execution;
- action context/variables;
- jobs, retries and cancellation where safe;
- dry run and manual execution;
- loop/depth/dedupe protection;
- execution logs;
- registered Action/Trigger extensions;
- frontend designer and logs.

Not included:

- long-running approvals/human tasks/parallel orchestration — Workflows owns this;
- direct ownership of CRM/Task/Activity/Communication/Document data;
- arbitrary tenant code execution.

## Primary actors

- Workspace Owner/Admin
- Process Owner
- Sales/Support Manager
- Integration Developer
- Support/Operations reviewer
- Automation service identity

## Core components

Recommended logical components; adapt names to repository conventions:

```text
AutomationRuleService
AutomationRevisionService
AutomationTargetRegistry
TriggerRegistry
ConditionEvaluator
ActionRegistry
AutomationScheduler
AutomationExecutionService
ActionExecutionService
AutomationDryRunService
ExecutionLogger
LoopGuard
AutomationExtensionRegistry
```

## Core entities

See `../Shared/data-model.md`. Principal concepts:

- automation_rules
- automation_rule_revisions
- automation_triggers
- automation_condition_nodes
- automation_actions
- automation_jobs
- automation_executions
- automation_action_executions
- automation_logs
- automation_extension_definitions

## Main flow

```text
Domain/External Event
  -> normalize trigger context
  -> find active published Rules for target/event
  -> deterministic ordering
  -> evaluate conditions
  -> create execution/job pinned to Rule revision
  -> immediate or scheduled execution
  -> re-check stale/current state when required
  -> execute ordered Actions through owning services
  -> log results / retry safe failure
  -> emit follow-up domain events
```

## Business invariants

1. Published revisions do not mutate.
2. Rule execution is always tied to a specific revision.
3. Every target is Workspace validated.
4. Conditions and action schemas are server validated.
5. Automation never bypasses module authorization/validation.
6. Retries must not duplicate side effects.
7. Delayed jobs re-check relevant current state.
8. Loop/depth controls terminate runaway chains.
9. Failures are visible and actionable.
10. Dry run has no business/external side effects.

## Dependencies

- Workspace/Permissions
- CRM Core
- Pipelines & Stages
- Custom Fields/Required Fields
- Activities
- Tasks
- Communication
- Files/Documents
- Notifications
- Integrations/Webhooks
- Shared Events/Outbox/Jobs/Audit

Dependencies may be adapters if their owning module is not yet implemented.

## Acceptance criteria

- Admin can create Draft Rule, configure target/trigger/conditions/actions and publish it.
- Matching domain events execute all eligible Rules exactly as configured.
- Non-matching conditions produce no business side effect.
- Delayed jobs do not act on invalid stale state.
- Duplicate event/job retries do not duplicate effects.
- Published edits create new revisions without changing already-created delayed jobs.
- Logs identify what ran, why, under which revision and with what result.
- Cross-Workspace targeting is rejected.
- Automation chains terminate at configured safety limits.
