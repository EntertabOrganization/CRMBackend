# Duplicates, Merge & Data Quality — Module Specification

## Goal

Keep CRM customer data trustworthy by detecting likely duplicate Leads, Contacts and Companies, supporting safe same-type merge, and continuously measuring/fixing data-quality issues without corrupting Deals, legal records, financial history or other immutable business evidence.

## Boundary

This module owns:
- normalization profiles used for duplicate detection,
- duplicate rules,
- duplicate keys,
- candidate pairs/groups,
- exclusions,
- scan jobs,
- merge preview/execution evidence,
- relation-rebind logs and redirects,
- data-quality rules,
- findings,
- quality scores.

It does **not** own:
- Leads/Contacts/Companies/Deals themselves,
- Lead Conversion,
- Requisites/legal identities,
- invoice/payment/document snapshots,
- CRM activities/timeline source records.

All source-record writes must go through CRM/domain services.

## Primary actors

- Workspace Owner / Administrator
- Sales Operations
- Marketing Operations
- Data Steward
- Integration/Migration Operator
- Sales user with scoped merge rights
- Background worker/service identity

## Dependencies

Required:
- CRM Core Records
- Custom Fields
- Workspace/Permissions
- Platform Jobs/Outbox
- Audit
- Search/index refresh
- Forms/Import for candidate checks
- Timeline for user-facing merge event projection where approved

Optional/indirect:
- Communication identity normalization
- Requisites
- Analytics

## Core invariants

1. Every duplicate/quality record is workspace-scoped.
2. Default automatic duplicate detection applies to Lead, Contact and Company only.
3. Deal duplication is not inferred from customer duplication.
4. Merge is same entity type only.
5. Lead Conversion is not Merge.
6. Cross-type matching may warn but never merge.
7. Historical invoices, payments, generated documents and legal snapshots are not rewritten by merge.
8. Related Deals are rebound to the surviving customer record and remain separate Deals.
9. Automatic merge is allowed only when conflicts are safely resolvable under policy.
10. Fuzzy similarity can create a candidate, but fuzzy similarity alone cannot authorize automatic merge.
11. Every completed merge is investigable through immutable evidence.
12. Data-quality score by itself never blocks ordinary CRM actions; blocking behavior belongs to explicit business validation/required-field rules.
13. Searches/scans must respect current authorization when results are shown to users.

## Conceptual processing flows

### Record write flow

```text
CRM create/update
→ normalize eligible identity fields
→ upsert duplicate keys
→ evaluate realtime duplicate rules
→ create/update candidate evidence
→ emit candidate/quality events
```

### Full scan flow

```text
authorized user/scheduler
→ create scan job
→ checkpoint through entity records
→ recalculate duplicate keys/candidates
→ rebuild groups
→ refresh findings/scores
→ publish completion result
```

### Merge flow

```text
select same-type records
→ permission + workspace check
→ lock/version check
→ calculate preview
→ choose survivor/field decisions
→ confirm
→ transactional CRM updates/rebinding
→ write merge evidence + redirects + outbox/audit
→ refresh search/duplicate/analytics projections
```

## Suggested domain entities

Canonical concepts:
- `crm_duplicate_configs`
- `crm_duplicate_rules`
- `crm_duplicate_keys`
- `crm_duplicate_candidates`
- `crm_duplicate_groups`
- `crm_duplicate_exclusions`
- `crm_duplicate_scan_jobs`
- `crm_merge_operations`
- `crm_merge_sources`
- `crm_merge_field_decisions`
- `crm_merge_relation_logs`
- `crm_merge_snapshots`
- `crm_merge_redirects`
- `data_quality_rules`
- `data_quality_findings`
- `data_quality_scores`

If the existing repository already uses architecture labels such as `cleanup_operations`, adapt names rather than creating duplicate concepts.

## Permissions

Expected permission keys; map to existing registry naming if needed:

```text
duplicate.read
duplicate.scan
duplicate.merge
duplicate.exclude
duplicate.configure

quality.read
quality.resolve
quality.ignore
quality.configure
```

All permissions remain subject to record scope.

Merge execution additionally requires sufficient source-record update/delete/merge capability according to CRM policy for **every** selected source record.

## Event families

Recommended durable events:
- `DUPLICATE_CANDIDATE_DETECTED`
- `DUPLICATE_CANDIDATE_CLEARED`
- `DUPLICATE_SCAN_COMPLETED`
- `DUPLICATE_EXCLUSION_CREATED`
- `DUPLICATE_EXCLUSION_REMOVED`
- `CRM_RECORD_MERGED`
- `DATA_QUALITY_FINDING_CREATED`
- `DATA_QUALITY_FINDING_RESOLVED`
- `DATA_QUALITY_SCORE_UPDATED`

Event consumers must deduplicate by event ID/source version.

## Acceptance summary

The module is not finished until:
- normalized duplicate discovery works for Lead/Contact/Company,
- same-type merge is transactionally safe and audited,
- cross-workspace/cross-type attempts fail,
- fuzzy matches do not auto-merge by themselves,
- relationship rebind preserves valid business history,
- immutable commercial/legal history is unchanged,
- exclusions persist and are auditable,
- scans are resumable/idempotent,
- quality rules/findings/scores behave as specified,
- all targeted and cross-module tests pass.
