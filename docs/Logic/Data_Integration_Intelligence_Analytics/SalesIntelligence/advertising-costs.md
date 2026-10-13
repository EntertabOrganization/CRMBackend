# Advertising Providers, Campaign Hierarchy & Marketing Costs Specification

## Goal

Ingest ad-provider hierarchy/metrics/costs and offline/manual marketing costs so TrueCRM can reconcile spend against attributed pipeline/revenue.

## Provider architecture

Initial native provider priorities:
- Google Ads
- Meta Ads

They must be implemented as adapters through the generic Integration framework.

Do not couple Sales Intelligence domain types directly to provider SDK classes.

Adapter capabilities may include:
- OAuth connection,
- account listing/selection,
- incremental metric sync,
- campaign/ad hierarchy sync,
- cost/spend metrics,
- click/impression metrics,
- currency/timezone metadata,
- provider health/rate-limit handling.

## Campaign hierarchy

Use generic normalized hierarchy capable of representing:
- provider account,
- campaign,
- ad group/ad set,
- ad,
- keyword/search-term/creative where provider supports.

Suggested normalized entities:

```text
ad_accounts
ad_campaigns
ad_groups
ads
ad_dimensions/keywords optional
```

Each row retains:
- workspace,
- connection/provider,
- external ID,
- parent external/internal normalized ID,
- name,
- status if available,
- provider metadata needed for mapping.

Do not assume every provider has every hierarchy level.

## Marketing cost

Cost input origins:

```text
PROVIDER
MANUAL
IMPORT
```

Suggested fields:

```text
id
workspaceId
sourceId
providerKey nullable
connectionId nullable
adAccountId nullable
campaignId nullable
adGroupId nullable
adId nullable
periodStart
periodEnd/date
amount
currency
reportingAmount nullable
reportingCurrency nullable
fxSnapshotRef nullable
origin
externalId nullable
version/fingerprint
```

Use NUMERIC.

## Provider synchronization

Sync through Integration framework:
- incremental cursor/date windows where provider supports;
- deduplicate external metric records;
- never double-count provider retries;
- honor provider rate limits;
- map provider timezone/currency explicitly.

Provider corrected historical costs should create/update derived cost facts using stable external keys and history/version policy.

## Manual cost entry

Authorized users may create cost for:
- offline event,
- billboard,
- sponsorship,
- print,
- agency charge,
- other source/campaign.

Require:
- source,
- period/date,
- amount/currency,
- optional campaign metadata,
- note/document reference if business process requires.

Audit manual create/update/delete/archive.

## Cost import

CSV/XLSX cost imports reuse Module 14 import framework and a dedicated `MARKETING_COST` import adapter.

Support columns such as:
- source code/name mapping,
- external campaign ID/name,
- date/period,
- amount,
- currency,
- optional provider account.

Preview must show unresolved source/campaign mappings.

Do not create arbitrary new traffic sources silently unless import configuration explicitly allows controlled creation with permission.

## Currency

Preserve original cost currency.
Normalize to reporting currency using historical period-specific FX reference where reporting requires.

Do not recalculate old spend with current FX by default.

## Metrics

Provider metrics may include:
- impressions,
- clicks,
- conversions as provider-reported,
- spend.

Keep provider-reported conversion metrics conceptually separate from TrueCRM CRM/revenue attribution metrics.

## APIs

```text
GET  /api/v1/sales-intelligence/ad-accounts
GET  /api/v1/sales-intelligence/campaigns
GET  /api/v1/sales-intelligence/marketing-costs
POST /api/v1/sales-intelligence/marketing-costs
PATCH /api/v1/sales-intelligence/marketing-costs/:id
POST /api/v1/sales-intelligence/marketing-costs/import
POST /api/v1/sales-intelligence/provider-sync
```

Connection creation/auth itself is owned by Module 14 integration connection endpoints.

## Reconciliation

Reporting should reconcile:
- source/campaign period cost,
- attributed won revenue,
- attributed paid revenue,
- ROI/ROAS metrics according to Metric Registry.

Define denominator and zero-cost behavior explicitly in Analytics metrics.

## Audit

Audit manual cost changes and provider connection/config changes through owning modules.

Automated provider metric refresh is operational history, not one audit event per row.

## Acceptance criteria

- Provider retry does not double-count spend.
- Manual/import/provider costs coexist with explicit origin.
- Same external campaign ID in two provider connections cannot collide.
- Historical cost keeps original currency/period.
- Google/Meta adapters can be mocked through one provider contract.
- Provider-reported conversion does not overwrite TrueCRM attribution result.
- Cost import unresolved mappings are visible in preview.
