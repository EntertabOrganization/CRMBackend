# Cross-Module Audit, Retention, Security & Entitlement Contract

## Audit

Central immutable Audit service is mandatory for meaningful configuration/security mutations.

Required evidence families:

### Data Quality
- rule configuration,
- exclusion create/remove,
- merge execution,
- manual finding resolve/ignore.

### Integrations
- import start/cancel/undo,
- export security-sensitive actions according to platform policy,
- API application/credential lifecycle,
- integration connection/mapping changes,
- conflict resolution,
- webhook replay.

### Sales Intelligence
- source/rule/tracking configuration,
- manual source override,
- attribution settings/model/version changes,
- manual marketing cost changes.

### Analytics
- dashboard/report visibility changes,
- KPI changes,
- schedule lifecycle,
- BI credential lifecycle.

Audit stores:
- trusted workspace,
- actor/service,
- action,
- target type/ID,
- occurredAt,
- request/correlation ID,
- sanitized before/after or decision summary where appropriate.

Never store raw credential secrets.

## Retention defaults

Confirmed starting policy:

| Data category | Default |
|---|---|
| Export artifact binary | 24 hours |
| Import/export operational metadata | 180 days |
| Detailed webhook/provider/integration payload logs | 90 days |
| Merge snapshots/evidence | retain with relevant business history, subject to central policy |
| Critical audit | central audit/legal policy |
| Analytical facts | aligned to authoritative source retention |
| Derived caches/materializations | rebuildable, may be shorter-lived |

Workspace may choose longer retention where entitlement/policy allows.
Platform/legal minimum can prevent shortening.
Legal hold overrides ordinary purge.

Retention purge is itself logged/audited as required.

## Archive/disable vs hard delete

Prefer archive/disable for:
- duplicate/quality rules used historically,
- integration connections with sync history,
- attribution models/versions used in results,
- report/dashboard definitions referenced by schedule/history,
- KPI targets needed for historical reporting.

Hard-delete only when:
- no required historical reference,
- policy allows,
- permission allows,
- audit/evidence remains according to central policy.

## Secrets

Secure credential layer requirements:
- encrypted at rest using platform mechanism,
- access only to adapter/auth service needing it,
- one-time reveal for newly generated raw API/webhook/BI secrets,
- rotate/revoke,
- last-used metadata,
- redaction in logs/errors/audit,
- no secret returned from list/get,
- cache invalidation on revoke.

## SSRF and egress

Webhook/provider configurable URLs must use central safe HTTP client/egress policy:
- validate scheme,
- block local metadata/loopback/private targets unless explicitly allowlisted for controlled environment,
- DNS rebinding protections where platform client supports them,
- response size/time limits,
- redirect policy.

## File security

Import files use shared Files service/security scanning if available.
Generated exports use private object storage.
No public predictable object key.

## Privacy

Anonymous tracking obeys Sites/privacy settings.
Data export obeys field/record permission.
Operational support views sanitize sensitive payloads.

## Entitlements

Use `EntitlementService` or repository equivalent.

Possible capability keys (names adapt to catalog):

```text
data_quality.enabled
imports.enabled
imports.max_rows
exports.enabled
exports.max_rows
api.enabled
api.request_quota
integrations.max_connections
webhooks.max_subscriptions
sync.frequency
sales_intelligence.enabled
sales_intelligence.native_ad_providers
analytics.enabled
analytics.scheduled_reports
analytics.bi_connector
```

Never use:
```ts
if (plan.name === 'ENTERPRISE') ...
```

Entitlement denial returns explicit feature/limit error and does not delete stored business data.

## Rate/abuse limits

Apply rate limits to:
- public tracking redirects/events,
- API credentials/apps,
- webhook replay trigger,
- import/export creation,
- BI queries,
- expensive recalculation/rebuild endpoints.

## Operational views

Authorized admin/support views expose IDs/statuses/errors without unrestricted secrets:
- jobs,
- import rows,
- webhook delivery,
- sync run/conflict,
- provider events,
- scan jobs,
- analytics freshness/backfill,
- scheduled report runs.

## Acceptance criteria

- Secret is never exposed after creation/rotation response.
- Revocation blocks future use.
- Retention job cannot purge legal-held evidence.
- Archived model/version remains resolvable by historical result.
- Webhook target cannot access prohibited internal address.
- Entitlement change reduces future capability without deleting existing business records.
- Audit survives configuration archive/hard delete according to platform policy.
