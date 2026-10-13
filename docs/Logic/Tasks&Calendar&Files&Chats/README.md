# TrueCRM Collaboration Modules — Codex Pack

This implementation-ready pack specifies four connected TrueCRM domains:

1. Tasks & Projects
2. Calendar & Meetings
3. Files, Drive & Documents
4. Feed, Chat & Internal Communication

It is intended to be placed in or provided alongside the TrueCRM repository and given to Codex, Claude Code or another coding agent.

## Start here

The coding agent MUST read:

```text
Agent.md
```

before any module specification.

Then read the applicable domain `overview.md`, its child specification files, and the matching executable contracts in `tests/modules/Tasks&Calendar&Files&Chats/`.

## Suggested implementation goals

```text
Complete Tasks & Projects
Complete Calendar & Meetings
Complete Files, Drive & Documents
Complete Feed, Chat & Internal Communication
Complete the TrueCRM Collaboration Pack
```

## Implementation sequence

Recommended dependency-aware order:

```text
1. Tasks & Projects core data and rules
2. Calendar & Meetings
3. Files, Drive & Documents
4. Communication core
5. Cross-module bindings/provisioning
6. Realtime/outbox/notifications/search integration
7. Complete regression and security hardening
```

The actual repository may already contain some foundations. The agent must inspect first and implement only missing/incorrect behavior while preserving the specification contract.

## Pack structure

```text
TrueCRM_Codex_Pack/
├── Agent.md
├── README.md
├── manifest.json
├── Decision-Register.md
├── Source-Coverage.md
├── Traceability.md
├── Tasks-Projects/
├── Calendar-Meetings/
├── Files-Drive-Documents/
├── Communication/
└── tests/modules/Tasks&Calendar&Files&Chats/
```

## How to implement one module

1. Read `Agent.md`.
2. Read the domain `overview.md`.
3. Read the exact child spec(s).
4. Inspect repository architecture, schema, guards and tests.
5. Wire the matching test contracts.
6. Implement migrations/services/controllers/jobs/adapters required by the specs.
7. Run targeted tests until green.
8. Run the full regression suite.
9. Report FINISHED only under the Definition of FINISHED in `Agent.md`.

## How to implement the whole pack

Treat domain boundaries as strict application-service boundaries. Do not write directly into another module's tables simply because everything is in one PostgreSQL database. Cross-module workflows such as Project provisioning, Task Chat creation, File attachments and create-Task-from-Message must call owning services and use durable bindings/events.

## Testing philosophy

Files under `tests/modules/Tasks&Calendar&Files&Chats/` are executable TypeScript/Jest-style contract tests. They intentionally fail through a `contract()` helper until a coding agent connects them to the real repository implementation.

They are not disposable examples.

The agent must not skip/delete/todo a required scenario to make the suite green.

Tests cover, where applicable:

- happy paths
- invalid input
- backend authorization
- Workspace/tenant isolation
- resource relationship permissions
- state transitions
- optimistic concurrency
- idempotency
- recurrence
- transaction rollback/outbox
- provider failures
- public-token security
- file ACL intersection
- malware/quarantine state
- booking conflicts
- realtime durability and duplicate prevention
- retention and Legal Hold
- Audit evidence

## Scope note

This pack includes the core implementation contract plus extension points for later TrueCRM modules. Full Scrum/Flows, full AI/Bot platform behavior, customer Contact Center and the shared platform-service implementation itself are not reimplemented here; these modules integrate with those capabilities through explicit contracts.
