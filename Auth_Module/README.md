# EntertabCRM Auth Module — Codex Pack

This pack is designed to be copied into the repository and used directly by Codex or another coding agent.

## Start here

The coding agent must read:

```text
Agent.md
```

before doing any work.

Then give it a goal, for example:

```text
Complete Authentication
Complete Workspace
Complete Department
Complete Authorization
Complete Partner
Complete Audit
Complete the whole Auth Module
```

The agent is instructed to:
- inspect the real repository first
- load the matching specification
- implement the requested module completely
- adapt and wire the executable contract tests
- run and repair tests until green
- run the full regression suite
- only then report the module as FINISHED

## Pack structure

```text
Agent.md
Authentication/authentication.md
User/user.md
Workspace/workspace.md
Department/department.md
Department/sub-department.md
Department/department-members.md
Authorization/role-permission.md
Partner/partner.md
Audit/audit-log.md
Testing/...
```

The `.spec.ts` files under `Testing/` are intentionally failing contract tests until they are wired to the actual repository. They are not to be skipped or deleted.
