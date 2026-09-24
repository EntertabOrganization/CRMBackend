# Automation Triggers & Event Matching

## Purpose

Convert trusted TrueCRM domain events, schedules and registered integration signals into typed Automation trigger contexts.

## Trigger classes

The registry should support built-in trigger definitions such as:

- entity created;
- entity updated;
- configured field changed;
- pipeline/stage entered;
- pipeline/stage exited;
- form submitted / entity captured;
- activity created/completed/overdue;
- communication received/sent/delivery state;
- payment/invoice events when those modules register;
- manual execution;
- scheduled/time-relative trigger;
- registered custom integration trigger.

Only enable triggers for domain modules actually registered/available.

## Target registration

Automation core uses a registry rather than hard-coded switch statements scattered through the codebase.

A target adapter should expose at least:

- target type/code;
- how to load the authoritative record inside one Workspace;
- permitted trigger fields/events;
- permitted condition fields;
- available actions/capabilities;
- pipeline/stage metadata when relevant;
- permission checks;
- stable display metadata for frontend.

Initial stage-oriented target support: Leads and Deals where current CRM/Pipeline modules support them.

## Trigger context

Normalize to an immutable execution context similar to:

```ts
interface AutomationTriggerContext {
  eventId: string;
  eventType: string;
  workspaceId: string;
  targetType: string;
  targetId: string;
  occurredAt: string;
  actor?: { type: 'USER' | 'SERVICE' | 'SYSTEM'; id?: string };
  correlationId: string;
  causationId?: string;
  depth: number;
  changedFields?: Record<string, { before: unknown; after: unknown }>;
  payload?: Record<string, unknown>;
}
```

Do not trust payload Workspace or target identity when the trusted event/integration installation already supplies authoritative context.

## Custom Trigger registration

Registered extension Trigger definitions include:

- stable code;
- name/description;
- provider/app installation identity;
- supported target types;
- optional typed payload schema;
- authentication/verification policy;
- enabled state;
- version where schema evolution requires it.

Payload schema must reject unknown/invalid values according to the definition policy.

Payload is read-only context. It never writes CRM fields without an explicit configured Action.

## External trigger invocation

Recommended logical endpoint family:

```text
POST /api/v1/crm/automation/custom-triggers/:triggerCode/execute
```

Actual external/public routing may live in Integration APIs if that is repository convention.

Requirements:

- authenticate app/service/integration;
- resolve Workspace from trusted installation/credential context;
- validate Trigger ownership/enablement;
- validate target belongs to Workspace;
- validate payload schema;
- require/derive idempotency/provider event ID;
- enqueue/execute normal matching pipeline;
- never accept caller-selected privileged execution identity.

## Reference behavior from Bitrix

Official Bitrix REST documentation demonstrates stable trigger codes and explicit owner type/owner ID targeting for `crm.automation.trigger.add` and `crm.automation.trigger.execute`. TrueCRM adopts the general extensibility pattern, not Bitrix-specific storage or owner type numbers.

## Acceptance criteria

- Trigger matching is deterministic.
- Unknown Trigger codes fail safely.
- Invalid typed payload returns field/schema errors.
- Duplicate external trigger event IDs do not duplicate Rule side effects.
- A target ID from another Workspace is rejected.
- Trigger payload cannot bypass domain validation.
