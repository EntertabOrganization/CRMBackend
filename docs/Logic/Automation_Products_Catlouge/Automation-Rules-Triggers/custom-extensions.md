# Custom Automation Extensions

## Purpose

Allow installed applications/integrations to extend Automation with controlled Trigger and Action types without executing arbitrary tenant code inside TrueCRM.

## Extension definition

Suggested fields:

- `id`
- `workspaceId` or installation scope according to app model
- `installationId`
- `extensionKind` = `TRIGGER | ACTION`
- immutable `code`
- `name`
- `description?`
- schema/version
- supported target types
- configuration schema / payload schema
- enabled state
- handler reference/adapter type
- permissions/capabilities
- created/updated audit metadata

Global/platform extensions may be defined outside a Workspace but must be explicitly installed/enabled per Workspace according to the integration model.

## Schema

Use a restricted schema representation (JSON Schema subset, Zod-generated schema, or repository-equivalent) with:

- primitive types;
- enums;
- arrays/objects within bounded depth;
- required properties;
- length/range rules;
- no executable code.

## Trigger extensions

Inbound call must be tied to authenticated app/integration installation. The integration cannot choose another Workspace.

Optional payload is validated, stored only as much as required by retention/logging policy, and exposed read-only to Rule evaluation.

## Action extensions

The action handler receives only:

- scoped target context;
- validated action configuration;
- resolved variables;
- execution metadata/idempotency key;
- authorized integration credential reference where configured.

Never pass raw DB connection, unrestricted secret store, or platform superuser token.

## Secrets

Action configuration stores a secure secret/connection reference, not plaintext API tokens.

Logs redact credentials and configured secret values.

## Lifecycle

Disabling/uninstalling an extension:

- prevents new publish/use;
- existing active Rules depending on it become visibly invalid/disabled according to product policy;
- pending jobs re-check extension availability and fail/skip safely;
- history remains readable.

## Bitrix reference

Bitrix's `bizproc.robot.add` and CRM Automation Trigger APIs demonstrate the value of stable extension codes, typed properties and app-scoped registration. TrueCRM keeps its own domain model and stronger repository-integrated authorization/idempotency rules.

## Acceptance criteria

- Duplicate code within one extension namespace is rejected.
- Invalid payload/configuration is rejected before execution.
- Uninstalled extension cannot silently keep executing.
- Secrets never appear in API/log responses.
