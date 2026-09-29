# Sales Intelligence & Attribution — Module Specification

## Goal

Track where visitors/customers/opportunities originate, preserve multi-touch marketing evidence, ingest advertising/offline costs, and calculate explainable revenue attribution without replacing CRM operational source fields or Marketing campaign execution.

## Boundary

This module owns:
- traffic source registry and source-resolution rules,
- visitor/session identifiers,
- attribution touches,
- identity links between anonymous tracking and known CRM customers,
- managed tracking links,
- static tracking numbers,
- source-associated inbound email aliases where provider capability exists,
- campaign/ad hierarchy observations used for attribution,
- marketing costs and provider metrics,
- attribution model definitions/versions/settings/results.

It does not own:
- CRM Lead/Contact/Company/Deal records,
- ad campaign creation/execution,
- Marketing campaign sends,
- payment truth,
- website cookie-consent UI,
- telephony provider's call system.

## Dependencies

- Sites/Landing Pages
- CRM Forms
- CRM Core
- Contact Center/Communication
- Marketing
- Estimates/Invoices/Payments
- Commerce where relevant
- Integration provider adapters
- Platform Jobs/Outbox
- Permissions/Audit
- Analytics

## Core invariants

1. Operational record-creation source is separate from marketing acquisition source.
2. Customer acquisition source is separate from each Deal opportunity source.
3. Multiple touches are retained.
4. Attribution is derived and recalculable; raw permitted touch evidence is not overwritten by model changes.
5. Every attribution result stores model/version and revenue basis.
6. Default attribution window is 28 days; workspace configurable within supported policy such as 1–365 days.
7. Anonymous tracking is governed by workspace privacy/cookie policy.
8. Default cross-device stitching is deterministic, not probabilistic fingerprinting.
9. Historical costs and FX interpretations are period-specific/versioned.
10. Google Ads and Meta Ads are initial native provider priorities, implemented through adapters.
11. Source override is auditable and does not destroy original evidence.

## Primary actors

- Marketing user
- Sales manager
- Growth/RevOps
- Finance analyst
- Workspace admin
- Integration service identity
- Analytics consumer

## Suggested entities

- `traffic_sources`
- `traffic_source_rules`
- `visitors`
- `visitor_sessions`
- `visitor_identity_links`
- `attribution_touches`
- `tracking_links`
- `tracking_numbers`
- `tracking_email_aliases`
- `ad_accounts`
- `ad_campaigns`
- `ad_groups`
- `ads`
- `marketing_costs`
- `marketing_provider_metrics`
- `attribution_models`
- `attribution_model_versions`
- `attribution_settings`
- `attribution_results`
- `attribution_result_allocations`

Names may adapt to existing repository conventions.

## Permissions

Suggested:

```text
sales_intelligence.read
sales_intelligence.configure
sales_intelligence.source.override
sales_intelligence.tracking.manage
sales_intelligence.cost.read
sales_intelligence.cost.manage
sales_intelligence.attribution.recalculate
```

Access to linked CRM records still follows CRM permission scope.

## Event families

Recommended:
- `ATTRIBUTION_TOUCH_RECORDED`
- `CUSTOMER_IDENTIFIED`
- `DEAL_OPPORTUNITY_SOURCE_SET`
- `MARKETING_COST_IMPORTED`
- `ATTRIBUTION_RESULT_UPDATED`
- `TRACKING_LINK_CLICK_RECORDED`

## Acceptance summary

The module is finished only when:
- sources resolve deterministically and explainably,
- visitor/session/touch capture respects privacy policy,
- identity linking is deterministic and workspace-safe,
- customer and Deal source remain distinct,
- tracking links/static call/email-source mechanisms function,
- costs ingest from provider/manual/import paths,
- attribution models calculate reproducibly with version/basis,
- results feed Analytics without becoming transaction truth,
- tests reconcile touch allocations and revenue totals.
