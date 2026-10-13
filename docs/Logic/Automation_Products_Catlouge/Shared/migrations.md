# Database Migration & Compatibility Strategy

## General rules

- inspect existing schema/migrations first;
- never edit applied migration history;
- create forward migrations;
- migrate/backfill before enabling constraints that existing data may violate;
- validate on staging before production;
- production execution is an explicit deployment operation.

## Automation rollout

Recommended sequence:

1. definition/revision tables;
2. jobs/execution/action-execution tables;
3. extension definitions;
4. indexes/uniqueness;
5. seed built-in trigger/action metadata if repository persists registry records;
6. enable consumers/workers after schema exists;
7. enable UI/Rule publication.

Do not consume source events before dedupe/execution persistence is ready.

## Catalog rollout

Recommended sequence:

1. Catalog/category/Product base schema;
2. create default Catalog for existing Workspaces if required;
3. Units and default Unit seed if product records require it;
4. Price Types and base Price Type backfill;
5. Product prices;
6. property bindings to existing Custom Fields infrastructure;
7. Product Rows integration/migration if existing CRM already has rows;
8. uniqueness/index constraints after compatibility checks.

## Existing Product data

If repository already has Product rows/products:

- inventory current shapes;
- map identifiers without rewriting historical commercial values;
- preserve existing Product Row snapshots;
- do not force Product master linkage for legacy manual rows;
- establish base Catalog/Price Type deterministically;
- report ambiguous legacy SKU duplicates before enforcing uniqueness.

## Rollback

Schema rollback must not require destructive removal of newly created business data. Prefer forward-fix migrations. Deployment rollback plans may disable new feature flags while retaining compatible schema.

## Index review

At minimum consider:

- Workspace + Rule target/state;
- due Automation jobs by status/scheduled time;
- execution lookup by Rule/target/date;
- Workspace + Product SKU unique index;
- Catalog/category tree lookups;
- Product category membership;
- Product type/state/name search support;
- Price by sellable item + Price Type;
- Product Row owner lookup.

Avoid speculative indexes on every Product property.
