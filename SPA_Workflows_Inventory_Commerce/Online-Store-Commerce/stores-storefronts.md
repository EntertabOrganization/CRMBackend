# Stores, Storefronts and Catalog Publication — Implementation Specification

**Scope:** Online Store & Commerce  
**Phase:** CORE (Phase 2 boundaries described in rules where relevant)  
**Controllers:** `CommerceStoresController`, `CommerceStorefrontsController`  
**Source of truth / domain entities:** `commerce_stores; commerce_storefronts; commerce_product_publications; commerce_category_publications`

## Goal and responsibilities

Implement this domain boundary as a complete, transactionally reliable NestJS vertical slice. The controllers listed here own these REST operations; application services own business rules, while shared platform services own Auth, Audit, Search, Jobs, and Webhook delivery. Do not create a second domain record in another module merely to display a relation/projection.

## Entity, fields, relationships and enums

- commerce_stores: id,workspace_id,code,name,status DRAFT|ACTIVE|SUSPENDED|ARCHIVED,default_currency,timezone,default_warehouse_id?,catalog_id,reservation_timing CART|ORDER_PLACED|PAYMENT_AUTHORIZED|PAYMENT_PAID|MANUAL default ORDER_PLACED,deal_creation_policy NEVER|ALWAYS|ONLY_NEW_CUSTOMER|MANUAL_REVIEW default ALWAYS,version.
- commerce_storefronts: workspace_id,store_id,id,type WEB|HEADLESS|MOBILE|SOCIAL|EMBEDDED,slug,domain?,status DRAFT|PUBLISHED|SUSPENDED,configuration_json,published_at.
- commerce_product_publications: workspace_id,store_id,product_id,variant_id?,published,available_from?,available_until?,seo_slug,version; unique(store_id,inventory_key).

All business rows carry `workspace_id` directly (or validated through strong parent FK). FK pairs must enforce the same Workspace even if IDs are valid. IDs UUID. Use timezone-aware instants, `NUMERIC` quantities/money and explicit unique indexes. Entity names below are logical contracts: use the repository ORM naming mapping without changing required behavior.

## REST endpoint inventory and request/effect contracts

| Method | Path | Controller | Permission | Request / Query | Outcome / Effects |
|---|---|---|---|---|---|
| `POST` | `/api/v1/commerce/stores` | `CommerceStoresController` | `COMMERCE.STORE_MANAGE` | name,code,defaultCurrency,timezone,catalogId | New DRAFT Store. |
| `GET` | `/api/v1/commerce/stores` | `CommerceStoresController` | `COMMERCE.STORE_VIEW` | page,limit,status,search | Workspace-scoped Store list. |
| `GET` | `/api/v1/commerce/stores/:storeId` | `CommerceStoresController` | `COMMERCE.STORE_VIEW` | storeId | Settings, status, effective permissions. |
| `PATCH` | `/api/v1/commerce/stores/:storeId` | `CommerceStoresController` | `COMMERCE.STORE_MANAGE` | expectedVersion,settings changes | Validate currency, warehouse, inventory/payment impacts. |
| `POST` | `/api/v1/commerce/stores/:storeId/activate` | `CommerceStoresController` | `COMMERCE.STORE_MANAGE` | expectedVersion | Activation requires valid catalog/currency/publication/payment policy. |
| `POST` | `/api/v1/commerce/stores/:storeId/suspend` | `CommerceStoresController` | `COMMERCE.STORE_MANAGE` | expectedVersion | Stop public checkout, retain existing Order servicing. |
| `GET` | `/api/v1/commerce/stores/:storeId/storefronts` | `CommerceStorefrontsController` | `COMMERCE.STORE_VIEW` | storeId | List WEB/HEADLESS etc. |
| `POST` | `/api/v1/commerce/stores/:storeId/storefronts` | `CommerceStorefrontsController` | `COMMERCE.STORE_MANAGE` | type,slug,domain? | Create draft Storefront. |
| `POST` | `/api/v1/commerce/storefronts/:storefrontId/publish` | `CommerceStorefrontsController` | `COMMERCE.STORE_MANAGE` | expectedVersion | Publicly activate allowed V1 WEB/HEADLESS context. |
| `GET` | `/api/v1/commerce/stores/:storeId/publications` | `CommerceStoresController` | `COMMERCE.CATALOG_PUBLISH` | page,limit | Publication rules. |
| `PUT` | `/api/v1/commerce/stores/:storeId/publications/:productId` | `CommerceStoresController` | `COMMERCE.CATALOG_PUBLISH` | variantId?,published,seoSlug,availabilityWindow | Publish only active Catalog product with valid price. |
| `GET` | `/api/v1/storefront/:storeSlug/products` | `CommerceStorefrontsController` | `PUBLIC_SCOPED` | page,limit,search,categoryId? | Published products only; no private warehouse detail. |
| `GET` | `/api/v1/storefront/:storeSlug/products/:productSlug` | `CommerceStorefrontsController` | `PUBLIC_SCOPED` | productSlug | Public sellable price/currency/media from published configuration. |

For a creation payload, the listed business fields are the accepted fields; server-populated `workspaceId`, actor, timestamps and sequence numbers are never accepted from callers. See `API-Contracts.md` for validation, response envelopes, pagination, error mapping, idempotency keys and concurrency. Every endpoint must have an OpenAPI operation and verified controller mapping.

## Workflows, state transitions and business rules

1. Store and Storefront distinct. Workspace may have many Stores, each with WEB and HEADLESS V1; MOBILE/SOCIAL/EMBEDDED are adapter-ready only.
2. Published Store must have valid catalog, currency, payment/delivery policy; suspended Store rejects new public checkout but permits authorized fulfilment/returns.
3. Product Catalog/Prices/Variants remain CRM Product module source, published entries contain only public exposure metadata; no cloned master catalog.
4. Public storeSlug resolves server-side Workspace/Store; public payload cannot override workspaceId or price/stock; public products exclude unpublished, inactive, unpriced, out-of-window entries.
5. Store credentials/domains/config sensitive fields never shown through public queries.

## Authorization, ownership and tenant isolation

- **Scope of policy:** declared `Permission` for each operation, plus type/document/warehouse/order/actor context as specified above. Public tokens grant only explicitly scoped access.
- **Workspace filter:** all reads, joins, writes, relationship IDs and background jobs use the resolved Workspace; invalid cross-Workspace IDs behave as inaccessible and cannot infer foreign private resource metadata.
- **Field-level safety:** private schema/financial/secret fields may not leak through read, sorting, search, export, logs, errors or public endpoints.
- **Cross-module effects:** call the owning domain service, never directly insert/update another module's table. Service-account actions require least-privilege explicit grants.

## Concurrency, retry, rollback and external failures

- For all `expectedVersion` operations, stale writes return 409 `RESOURCE_VERSION_CONFLICT`, with zero partial mutation/outbox.
- All `Idempotency-Key` commands and external callbacks use a durable dedupe record plus operation-specific unique indexes. Retrying exact payload returns prior outcome; changed payload rejects 409.
- Critical mutation + history + outbox + audited evidence commit once. Simulate failure before commit and assert rollback. Cross-provider effects are asynchronous with visible state, bounded retries and replay-safe compensation.
- Jobs expose QUEUED/RUNNING/SUCCEEDED/FAILED and correlation ID; do not claim provider success on a browser redirect or client request alone.

## Stable domain error codes

- `COMMERCE_STORE_NOT_FOUND`
- `COMMERCE_STORE_INVALID_STATUS`
- `COMMERCE_STORE_NOT_READY`
- `COMMERCE_PRODUCT_NOT_PUBLISHED`
- `COMMERCE_PRICE_MISSING`
- `COMMERCE_STOREFRONT_SLUG_EXISTS`

## Durable domain events and global audit

- **Outbox events:** `COMMERCE_STORE_CREATED`, `COMMERCE_STORE_ACTIVATED`, `COMMERCE_STORE_SUSPENDED`, `COMMERCE_PRODUCT_PUBLISHED` .
- Outbox data uses common event envelope, generated after domain validation but within same DB commit. Integration webhook, Search, Notifications, Analytics and Workflow consumers handle events idempotently.
- **Central Audit:** record security/configuration/ownership/public access/critical financial/ledger changes; immutable domain histories store routine high-volume row/node/movement evidence. Preserve causation actor and initiating principal.

## Dependencies and integrations

Product Catalog, Files for public media, Sites/domains, Entitlements, Shared Search.

## Testing contract — executable and E2E

Matching files: `Testing/Online-Store-Commerce/stores-storefronts.spec.ts` and `Testing/Online-Store-Commerce/stores-storefronts.e2e-spec.ts`. Start by replacing fail-closed `contract()` calls with real fixture setup/API/service calls; do not skip tests. The following cases are required, along with common auth, tenant and idempotency tests for every operation:

- **1.** store code unique within workspace and slug collision handled
- **2.** Store activation validates catalog/payment/delivery prerequisites
- **3.** unpublished product absent from public listing and direct detail
- **4.** public catalog hides warehouse balance and internal cost
- **5.** suspended Store blocks checkout but admin retains Order access
- **6.** WEB and HEADLESS available; unsupported type activation denied in V1
- **7.** wrong workspace Store/warehouse/catalog reference denied

## Acceptance criteria / definition of done

1. Every operation in this specification is implemented with its exact authorization, DTO validation, domain semantics, errors and response shape.
2. Required database constraints/indexes/migrations run on a clean test database and against representative prior version migration; no destructive silent schema rewrite.
3. All listed unit scenarios and real HTTP E2E tests pass with meaningful assertions; no hidden skips/placeholders. Negative tenant/permission tests and race/retry tests are mandatory.
4. Immutable history, permitted repairs, audit and outbox effects match specified transitions, including rollback and worker/provider failure scenarios.
5. Relevant frontend state/actions use shared components and API contracts without inventing permission shortcuts; Phase 2 is explicitly not claimed complete.
