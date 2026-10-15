# Security, validation and privacy threat model

## Risks and controls

- **Tenant object reference:** UUID known by attacker is insufficient. Server resolves resource workspace and compares to trusted membership/public host/credential context on every read/write/relationship/list/export.
- **Client price and financial integrity:** never trust cart total/currency, paid flag, tax, coupon discount, payment callback body without verification. Decimal arithmetic and immutable Order snapshots; refunds checked against original successful capture net of previous refunds.
- **Marketing anti-abuse:** consent at delivery time, suppression and complaint at all times, sender verification, rate/volume ceilings, unsubscribe usable without authenticated CRM access, per-channel/jurisdiction policies.
- **Employee privacy:** segregate directory from confidential HR fields/documents/reasons/location evidence; role+scope+field controls; audit sensitive reads; evidence collected only at check-in where configured; no continuous tracking.
- **Site scripts and content injection:** validate block schema and sanitize HTML/URLs, deny arbitrary server execution, CSP allowlist, restrict custom JavaScript to approved vetted sandbox integration; never expose server credentials into browser script.
- **Upload and imports:** shared Files quarantines/scans, limit byte size/rows/file type; CSV formula injection mitigated on export; render only safe media derivatives; file ACL and attached resource ACL intersect.
- **Webhook spoofing/replay:** signature/timestamp/provider verification plus connected-account lookup and unique event ID. No public self-asserted workspace ID.
- **SSRF/open redirect:** allowlist outbound webhook/proxy destinations, reject internal/link-local ranges, validated redirect targets and signed order links.
- **General:** secret vault, TLS, CSRF controls for cookie sessions, CSP/headers, query parameter validation, per-principal/IP quotas, least privilege, request ID logs and incident alerts.

## Requirements for tests

Per module: unauthorized create/edit/export; allowed OWN but disallowed other owner; same-workspace but wrong department; forged cross-workspace parent ID; guessing public UUID; request replay under concurrency; external signature tamper; command version conflict; privileged action audit; privacy redaction of response/events/logs.

## Legal configuration vs default

No universal data protection/tax/labor policy is asserted as legally sufficient. Country/jurisdiction policy owners must configure applicable requirements before go-live. A missing mandatory policy is a controlled readiness error, not permission to silently send, pay, employ or collect tracking evidence.
