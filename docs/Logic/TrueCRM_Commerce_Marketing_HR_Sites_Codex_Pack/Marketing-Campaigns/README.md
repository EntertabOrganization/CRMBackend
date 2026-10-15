# Marketing-Campaigns — module map

Core V1: segments, importing, consent, provider setup, approved one-off campaigns, queues, engagement and reporting; Advanced: experiments, nurture journeys, Meta/Google audiences, repeat-sale triggers (provider adapters still targeted in initial integration plan).

**Core invariant:** Audience snapshot is frozen; recipient eligibility is re-evaluated at send time. Attribution remains owned by Sales Intelligence.

## Submodule specifications

- [`01-segments-and-audiences.md`](01-segments-and-audiences.md) — Allow reproducible targeting of CRM people and authorized imported audience-only identities.
- [`02-audience-imports.md`](02-audience-imports.md) — Support validated static lists without automatically creating CRM Contacts.
- [`03-consent-and-suppression.md`](03-consent-and-suppression.md) — Record verifiable communication permission by recipient, channel, purpose and jurisdiction.
- [`04-sender-and-provider-config.md`](04-sender-and-provider-config.md) — Support platform-managed or workspace-owned sending accounts with explicit quota ownership.
- [`05-templates-and-content.md`](05-templates-and-content.md) — Maintain approved immutable per-channel message versions and safe personalization.
- [`06-campaigns-and-approvals.md`](06-campaigns-and-approvals.md) — Control one-off and scheduled campaigns with risk-based approval and exactly-once scheduling.
- [`07-delivery-jobs-and-retries.md`](07-delivery-jobs-and-retries.md) — Deliver campaigns safely with per-recipient idempotency and provider-event processing.
- [`08-engagement-and-conversions.md`](08-engagement-and-conversions.md) — Track available engagement signals and reconcile campaign counts without claiming inaccurate opens as verified reads.
- [`09-experiments-and-journeys.md`](09-experiments-and-journeys.md) — Support auditable message experiments and durable multi-step marketing journeys through existing Workflows.
- [`10-ad-platforms-and-repeat-sales.md`](10-ad-platforms-and-repeat-sales.md) — Sync opted-in audiences with Meta/Google, import platform results, and connect repeat-sales conversion through attribution.

## External owner boundaries

Own only records declared in the above specs. Other domains must be accessed through narrow typed service contracts, not direct table writes.

## Activation readiness / configuration

- Authenticated workspace membership/permissions and active entitlement must be resolved.
- Applicable locale/jurisdiction, tax, HR, consent and retention policies must be configured before enabling their corresponding operations.
- Any external provider needed for production operation must have a verified identity, separate secret and observable health state.
- Missing operational dependency must be surfaced as a blocker, never auto-created as a second source of truth.

## Tests

Every file above maps to `Testing/Marketing-Campaigns/<same-slug>.spec.ts`; module E2E in `Testing/Marketing-Campaigns/Marketing-Campaigns.e2e-spec.ts`. See `Testing/README.md`.
