# Authorization & Security Contract

## Core rule

Every request resolves authenticated identity and active Workspace membership before module authorization.

Automation service execution resolves an explicit Workspace-scoped service policy, not a global superuser.

## Automation authorization layers

Configuration request:

```text
membership
∩ module permission
∩ action permission (edit/publish/execute/log/retry/etc.)
∩ target configuration access if needed
```

Runtime action:

```text
trusted Workspace
∩ Rule/revision state
∩ target same Workspace
∩ execution identity policy
∩ owning-domain permission/state
∩ field/stage restrictions
∩ feature entitlement/limits where applicable
```

## Catalog authorization layers

Master-data mutation:

```text
membership
∩ catalog/product permission
∩ relevant admin capability
∩ same-Workspace relationships
```

Product Row mutation:

```text
owner-record permission
∩ product-row action permission
∩ Product/Catalog visibility
∩ separate price/discount/tax override permissions
```

## IDOR prevention

Never query by naked ID and only later check Workspace if the repository can scope the query itself. Prefer `(workspaceId, id)` lookup or equivalent guarded repository method.

## Mass assignment

DTOs explicitly whitelist mutable fields. Never map arbitrary request objects directly into ORM create/update data.

Automation Action field updates must whitelist fields available through target adapter and call normal target update service.

## Secrets

- integration secrets stored in secure secret/credential layer;
- Rule configuration stores credential reference only;
- logs/responses redact secrets;
- never include secrets in outbox events or frontend metadata.

## External calls

Protect against SSRF and uncontrolled egress. Validate URL/protocol and follow platform allow/block policy. Limit redirects, response size and timeout.

## Rate/abuse controls

Apply sensible rate limiting to:

- manual Automation execution;
- dry run if expensive;
- custom trigger ingestion;
- bulk Variant generation;
- Catalog search endpoints if public/external integrations use them.

## Stable disclosure

Permission errors must not leak existence of another Workspace's objects. Prefer repository-standard not-found/permission behavior consistently.

## Security acceptance criteria

- Cross-Workspace Rule/target/Product reference fails.
- User cannot publish without publish permission.
- Custom trigger cannot choose another tenant.
- Product Row override cannot be smuggled via normal row save.
- Secret not returned in Rule/extension APIs.
