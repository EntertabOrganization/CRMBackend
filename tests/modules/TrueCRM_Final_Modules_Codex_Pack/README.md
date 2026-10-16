# Executable contract tests — fail-closed until real repository wiring

One `.spec.ts` exists for each of 48 specification files, with every AC ID and the four shared safeguards. Five module `.e2e-spec.ts` suites and one CrossModule suite cover complete behaviors. The files contain **runnable Jest-style TypeScript**, but the supplied `_harness/repository-adapter.ts` intentionally raises `CONTRACT_NOT_WIRED` until a real NestJS/Next.js/PostgreSQL test fixture is connected. They are **not passing tests** against an application yet.

## Correct implementation steps

1. Read `../Agent.md` and target Markdown spec.
2. Inspect the repo's existing test framework, migration/fixtures and CI. If Vitest is standard, port assertions without losing cases.
3. Implement `repositoryAdapter.runCase(...)` to execute the scenario against actual module/domain repository, transaction and HTTP/queue for E2E; collect at least two observable assertions including DB/source state, audit/outbox, external side effects or their absence.
4. Reject mock-only or self-attested `pass:true` evidence for E2E. If a dependency isn't built, leave the case failing and report blocker, do not fabricate a stub successful response.
5. Run `tsc --project Testing/tsconfig.contract.json --noEmit` (from pack root) for syntax/type shape, then run repository test runner on the connected suites; target DB/Redis fixtures plus provider sandboxes where required.
6. Never `.skip`, `.todo`, delete cases or return unconditional success. Report exact failing IDs and later full regression outcome.

## Harness contract

An adapter returns `{ pass:boolean, kind:'UNIT'|'INTEGRATION'|'E2E', assertionCount:number, observations:string[], implementationRefs:string[] }`. The harness rejects insufficient evidence, but QA must review that evidence comes from actual exercised code. This is the same fail-closed testing philosophy as the attached TrueAgent reference ZIP, expanded for Modules 28–32.

## Scenario coverage map

- ACxx: specific spec business rule (5+ per submodule)
- S01: cross-tenant and cross-Partner IDs
- S02: negative authorization and zero write/provider effect
- S03: idempotency/repeated message or event
- S04: atomic state+redacted audit+outbox
- Exx: full module journey through Nest+Postgres/queue/Next route as applicable
- Xxx: cross-module seam and recovery

Required external credentials, provider sandbox account approval and migration deployment access are prerequisites, not reasons to mark the tests green.
