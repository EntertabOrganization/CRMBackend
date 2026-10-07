# Source Coverage

## New-project source files considered

1. `TrueCRM - Product Requirements Document (PRD)`
   - Multi-tenant product scope, personas, functional requirements, permissions, acceptance criteria and module dependencies.
   - Specifically covered Tasks/Projects, Calendar/Meetings, Files/Documents and Feed/Chat/Communication sections.
2. `TrueCRM - Business Requirements Document (BRD)`
   - Business purpose, actors, rationale, business rules and success measures for the same domains.
3. `TrueCRM - System Architecture Document - Complete`
   - NestJS modular-monolith architecture, PostgreSQL/Redis/object-storage boundaries, outbox/jobs/realtime, domain components and data models.
4. `Bitrix-Documentation.txt`
   - Official Bitrix24 API documentation entry point supplied by the project owner.
5. `SKILL.md`
   - Used as the design-tree interview method until unresolved important decisions reached zero.

## Reference pack considered

`TrueAgent_Auth_Module_Codex_Pack(1).zip`

Used only for structural/testing philosophy:

- `Agent.md` as master execution contract
- module-oriented Markdown specs
- `README.md` start-here workflow
- `manifest.json` entrypoint/spec listing
- executable failing Jest-style contract tests
- repository-first implementation
- Definition of FINISHED

Its Auth/Workspace/Partner business content is not copied into TrueCRM domain behavior.

## Supplemental Bitrix-derived architecture considered

Previously prepared project architecture documents for:

- Tasks + Projects
- Calendar + Meetings
- Files / Drive / Documents
- Company Feed + Chat + Internal Communication

These were used as detailed behavioral/reference material where consistent with the PRD/BRD/System Architecture and the Q1–Q51 decisions.

## Official Bitrix24 research usage

Official/current Bitrix concepts were used to reduce unnecessary product questions, including:

- task CRUD, checklist, dependency, elapsed-time, template/stage and completion patterns
- project/workgroup membership concepts
- calendar sections/events/attendees/recurrence/resources/open slots/sync
- Disk storages/folders/files/versions/rights/public links
- Feed/Chat/Message/Channel/Collab communication concepts

Bitrix behavior is reference inspiration, not an instruction to reproduce Bitrix internals or naming when TrueCRM sources/decisions differ.

## Priority applied

1. Latest explicit Q1–Q51 decision
2. Previously confirmed TrueCRM decision
3. PRD/BRD/System Architecture
4. Existing repository behavior when the coding agent inspects it
5. Reference ZIP conventions
6. Architecture recommendation

## Coverage status

All supplied project sources were considered for this pack. No known important decision remains unresolved.
