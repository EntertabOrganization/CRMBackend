# 01-Orchestrator — agent responsibilities

This is a **role-specific execution lens**, not a parallel autonomous source of requirements. Read `../Agent.md` first.

## Mandatory responsibilities

Read Agent.md and all shared contracts; inventory current repository; enforce dependency order; maintain requirement->spec->test trace; stop only at genuine access/credential conflict; verify integration blockers and handoff evidence.

## Required handoff

- List changed code and migration paths, API/service boundaries touched, source specification IDs and acceptance IDs.
- Include exact commands run and their results; do not fabricate test evidence.
- State provider credentials, production config, migration approvals or external services still needed.
- Identify any business-rule conflict for human review instead of silently changing the specification.
- Keep module-specific logic in owning service, shared concerns in existing platform services.
