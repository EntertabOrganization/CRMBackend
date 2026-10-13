# Shared Data Model Contract

This file defines conceptual PostgreSQL ownership and key constraints. Adapt names to the established repository while preserving semantics.

## Automation tables

### automation_rules

```text
id UUID PK
workspace_id UUID NOT NULL
name
description nullable
target_type
priority
operational_state
active_revision_id nullable
draft_revision_id nullable
version integer NOT NULL
```

Indexes: Workspace + state + target type; Workspace + priority where useful.

### automation_rule_revisions

```text
id UUID PK
workspace_id
rule_id FK
revision_number integer
revision_state
trigger_definition/version reference or normalized relation
execution_timing config
execution_identity policy
published_at nullable
published_by nullable
config_hash nullable
```

Unique `(rule_id, revision_number)`.

Published revision content immutable at application and DB policy level where feasible.

### automation_triggers

Normalized configuration if not stored as revision JSON:

```text
id
workspace_id
revision_id
trigger_code/type
configuration_json validated
```

### automation_condition_nodes

If normalized tree:

```text
id
workspace_id
revision_id
parent_id nullable
node_type GROUP|CONDITION
group_operator ALL|ANY nullable
field/context reference nullable
operator nullable
typed value/config nullable
sort_order
```

A validated versioned JSON tree is acceptable if repository standards favor JSONB and publish validation is strict. Do not store executable code.

### automation_actions

```text
id
workspace_id
revision_id
action_code
sort_order
configuration_json validated
continue_on_error boolean
timing override nullable
```

Unique ordering within revision.

### automation_jobs

```text
id
workspace_id
rule_id
rule_revision_id
target_type
target_id
source_event_id
scheduled_at
status
attempts
max_attempts
idempotency_key unique within appropriate Workspace namespace
correlation_id
causation_id nullable
depth
trigger_context_json minimal/validated
last_error_code nullable
```

Indexes: due pending jobs; Workspace/status; Rule; target.

### automation_executions

```text
id
workspace_id
rule_id
rule_revision_id
target_type
target_id
source_event_id
job_id nullable
status
initiating_actor_type/id nullable
execution_identity reference
correlation_id
causation_id
depth
started_at
completed_at nullable
error_code nullable
```

Deduplication uniqueness appropriate to Rule revision + source event + target.

### automation_action_executions

```text
id
workspace_id
execution_id
action_id/action_code
action_order
status
attempt_count
idempotency_key
timestamps
safe result/error metadata
```

### automation_extension_definitions

Stores registered Trigger/Action extension metadata, not raw secrets.

## Catalog tables

### catalogs

```text
id UUID PK
workspace_id
name
code nullable
is_default boolean
is_active boolean
version
```

Enforce one default per Workspace with partial unique index or transaction + DB-safe equivalent.

### catalog_categories

```text
id
workspace_id
catalog_id
parent_id nullable
name
code/slug nullable
sort_order
is_active
version
```

Prevent cross-Catalog parent. Cycle prevention is application/transaction logic unless DB strategy exists.

### product_category_memberships

```text
workspace_id
product_id
category_id
is_primary
sort_order nullable
```

Unique Product/category membership. Enforce one primary per Product/Catalog context where memberships exist.

### products / product_variants

Repository may use one table with `type` + `parent_id` or separate tables. Semantics must support:

```text
id
workspace_id
catalog_id
type
parent_id nullable
name
sku nullable
state
primary_unit_id nullable
tax default fields/reference
commercial/display fields
version
```

Sellable SKU uniqueness per Workspace. Parent relationship same Workspace/Catalog and valid type.

Variant combination key unique per parent when axis combinations are used.

### units

```text
id
workspace_id
code
name
symbol nullable
is_active
```

Unique code per Workspace.

### product_unit_ratios

```text
id
workspace_id
product_id
unit_id
base_unit_id
ratio NUMERIC > 0
```

### price_types

```text
id
workspace_id
code
name
is_base
is_active
sort_order
version
```

Exactly one base per Workspace.

### product_prices

```text
id
workspace_id
product_id/variant_id
price_type_id
amount NUMERIC
currency
version
```

Unique current price key defined by item + Price Type + currency policy.

### product media

Use generic Files attachment/binding service rather than duplicate binary storage.

### commercial product rows

If owned here/shared commercial row service, at minimum:

```text
id
workspace_id
owner_type
owner_id
product_id nullable
product_name_snapshot
sku_snapshot nullable
unit_id/reference nullable
unit_name/code_snapshot
unit_ratio_snapshot nullable
quantity NUMERIC
price_type_id nullable
unit_price NUMERIC
currency
discount_type/rate/amount
taxable
tax_rate
tax_included
subtotal NUMERIC
tax_amount NUMERIC
total NUMERIC
sort_order
manual/override metadata
version if independently editable
```

The owning commercial module may own the row table; in that case reuse its table and enforce these semantics rather than duplicating it.

## Cross-cutting constraints

- all FKs validate Workspace either directly or through application + composite constraints where practical;
- use UUID primary keys unless repository proves another standard;
- use `timestamptz` for real instants;
- use `NUMERIC` for money/precise quantities/ratios;
- use optimistic version columns on contention-prone configuration;
- do not cascade-delete historical business references.
