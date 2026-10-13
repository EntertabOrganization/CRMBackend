# Automation Permissions & Security

## Administrative permissions

Map to existing TrueCRM permission keys. Preserve separate capabilities for:

- read Rule definitions;
- create/update Drafts;
- publish;
- pause/disable;
- execute manually;
- retry/cancel jobs;
- view execution logs;
- manage custom extension definitions/installations.

Publishing and managing extensions should be stronger permissions than merely editing a Draft.

## Execution identity policy

Rule configuration stores/derives an explicit policy, not a hidden superuser flag.

Allowed models include repository-approved forms of:

- initiating user for immediate user-originated actions;
- Automation service identity scoped to Workspace/module/actions for delayed/system/provider events.

The owning domain service still applies its business authorization policy for service execution.

## Security checks

Every execution checks:

1. trusted Workspace context;
2. active Rule/revision state;
3. target existence and same Workspace;
4. execution identity eligibility;
5. owner-module authorization/state;
6. field/stage restrictions where applicable;
7. Subscription entitlement if the platform gates Automation features/limits.

## Mass-impact safety

For potentially high-volume manual operations:

- require explicit permission;
- use background job/batch limits;
- show scope/record count preview where feasible;
- rate limit;
- audit actor and configuration revision.

## SSRF and external calls

HTTP/webhook Action must block unsafe private/internal destinations according to platform security policy. Do not allow arbitrary requests to cloud metadata services or internal control planes.

## Audit

Audit configuration changes and sensitive operational commands such as publish, disable, manual run, retry, cancel and extension registration.

Audit is separate from execution log. Execution log explains Automation behavior; Audit proves who changed configuration/issued sensitive commands.

## Acceptance criteria

- User with edit but no publish permission cannot activate Rule.
- User cannot manually execute Rule against inaccessible target.
- Service execution does not become blanket Workspace admin.
- Cross-Workspace UUID is rejected even if valid.
- Webhook Action cannot expose stored secret in logs.
