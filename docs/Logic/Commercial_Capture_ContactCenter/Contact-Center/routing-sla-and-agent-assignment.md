# Routing, SLA and Agent Assignment Specification

> **Backend-only implementation scope:** This specification authorizes server-side work only: database schema and migrations, domain/application services, REST APIs, authorization, audit/outbox events, workers/jobs, provider adapters, and automated backend tests. Do not create, modify, scaffold, or test frontend pages, UI components, browser views, styling, or client-side application code. Any UI/browser wording below defines backend-facing behavior or security constraints only.


## Goal

Route new/unassigned Conversations to eligible agents using configurable policies and measure service levels against Workspace work calendars.

## Queue model

### Queue

```text
id UUID
workspaceId UUID
name string
channelId nullable UUID
routingMode FIXED | ROUND_ROBIN | LEAST_LOADED | BROADCAST | CUSTOMER_OWNER | RULE_BASED
fixedUserId nullable UUID
maxConcurrentPerAgent nullable integer
workCalendarId nullable UUID
slaPolicyId nullable UUID
reopenWindowMinutes/duration
active boolean
```

### Queue member

```text
queueId UUID
userId UUID
priority/order/weight as mode requires
capacityOverride nullable integer
active boolean
```

## Agent eligibility

Automatic router assigns only when all applicable are true:
- active Workspace membership;
- channel/queue permission;
- active queue membership or rule eligibility;
- work schedule/calendar allows assignment;
- not absent when HR/Calendar integration marks unavailable;
- agent availability permits new work;
- active Conversation load < capacity;
- provider/channel-specific constraints satisfied.

Manual manager override is explicit and audited.

## Routing modes

### FIXED
Use configured user if eligible, else fallback.

### ROUND_ROBIN
Use atomic cursor/order. Concurrent inbound events cannot corrupt rotation.

### LEAST_LOADED
Choose eligible agent with minimum active load and deterministic tie-breaker.

### BROADCAST
Notify/expose to eligible agents for claim. Claim is atomic: one winner, others get conflict.

### CUSTOMER_OWNER
Prefer CRM responsible owner when eligible, otherwise configured fallback.

### RULE_BASED
Declarative rules may route by approved fields such as channel, source, priority and CRM/customer attributes. No arbitrary tenant code.

## SLA model

Configurable by channel/queue/customer priority.

Timers:

```text
FIRST_RESPONSE
NEXT_RESPONSE
RESOLUTION
```

Business-time calculation uses configured work calendar and timezone.

Pause states may include configured `WAITING_CUSTOMER`; do not pause merely because agent is offline unless policy explicitly says so.

Persist sufficient SLA state:
- policy/version;
- startedAt;
- dueAt or accumulated business duration;
- pause intervals/state;
- satisfiedAt;
- breachedAt;
- escalation state.

Policy edits apply to new timers by default. Historical SLA retains policy version.

## Timer semantics

- FIRST_RESPONSE starts on eligible inbound opening/message and completes on first qualifying **human agent** response by default.
- NEXT_RESPONSE starts on qualifying later customer message and completes on next qualifying human response.
- RESOLUTION completes on Conversation close/resolution.

AI suggestions/system messages do not count as human response.

## Breach/escalation

Reliable scheduled jobs emit `SLA_BREACHED` at most once per timer and may trigger Notifications/Automation.

Retries cannot duplicate escalation.

## API

```text
GET/POST/PATCH /api/v1/contact-center/queues...
POST /api/v1/contact-center/conversations/:id/claim
GET /api/v1/contact-center/conversations/:id/sla
```

## Acceptance criteria

- router excludes inactive/unauthorized/off-hours/absent/over-capacity agent;
- round-robin safe under concurrency;
- broadcast claim has exactly one winner;
- customer-owner falls back if owner ineligible;
- SLA excludes configured non-working time;
- pause/resume preserves elapsed business time;
- breach/escalation occurs once despite retries;
- transfer preserves SLA history and applies configured continue/reset policy.
