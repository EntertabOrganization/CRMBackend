# Persistence, schemas, history and retention

## Database contract

PostgreSQL source of truth. Each owned table includes `workspace_id` or belongs to parent whose `workspace_id` is enforced at query/constraint boundary. IDs UUID. Domain-specific functional instants `timestamptz`, local dates `DATE`, policy timezone as IANA identifier. Monetary amount and precise stock/time account values use NUMERIC with controlled precision; never double/float. JSON is allowed for validated versioned rule trees, revision content and immutable snapshots, not as blanket substitute for relational models.

Recommended indexes: `(workspace_id,id)`, `(workspace_id,parent_id,status)`, `(workspace_id,provider,external_reference)` unique where applicable, `(workspace_id,actor_id,occurred_at)` for audit, `(workspace_id,resource_id,version)` for concurrency, unique `(campaign_id,recipient_key,channel,variant_id)` for send dedupe; partial indexes for live resources. Existing repo conventions may map columns but must preserve invariants.

## Source of truth by owner

- Commerce: Orders, Carts, Shipments, Returns and store config. CRM: Contacts, Companies, Deals. Catalog: Products/Variants. Inventory: movement ledger/reservations/balances. Commercial Payments: captures/allocations/refunds. Commerce stores typed *references* not copies of provider financial truth.
- Marketing: segments, frozen audience snapshot, campaign content versions, delivery ledger, consent/suppression, engagement events. Sales Intelligence: touch/revenue attribution.
- HR: EmployeeProfile (not Auth User), ScheduleVersions, immutable WorkEvents/corrections, LeaveLedger, TimesheetReviews, lifecycle cases. Tasks: separately logged task hours.
- Sites: Sites, PageRevisions/Blocks, Releases, Domains, content/nav/SEO. Forms: submission truth. Commerce: cart/order truth. Files: binary/version truth.

## Delete / recover / retain

- Deactivation/suspension never deletes commercial, HR or audit records. Soft-delete public site/page, segment, store and templates, with versioned retention policy; purge only after legal hold/business obligation/dependency validation.
- Protected financial records and critical audit events are append-only and remain available under explicit lawful retention policy. Correction by new event/adjustment, never rewrite history.
- Audience import records, visitor identifiers, attendance evidence, old website revisions, cart PII, CRM contact references and campaign engagement belong to DISTINCT retention categories.
- `RetentionPolicy`: (`workspaceId`, `jurisdiction`, `category`, `retentionDuration`, `effectiveFrom`, `legalBasis`, `sensitiveFields`, `disposalMethod`). `LegalHold`: (`workspaceId`, `scope`, `reason`, `placedBy`, `placedAt`, `releasedAt`). Policy evaluation must be auditable; production activation blocked if required jurisdiction/category policy absent.
- Anonymization requests preserve aggregate metrics and legal records only where policy permits; do not reveal deleted personally identifiable history via search, analytics, exports or backups beyond approved restoration procedures.
- Retention job uses dry-run/impact preview, leases, audited per-category disposition, and idempotent tombstone; never hard-delete an active resource as a side effect of plan downgrade.
