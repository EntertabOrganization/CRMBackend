# Database Schema & Transaction Contract

PostgreSQL is authoritative. Prisma/repository ORM names may vary; preserve logical ownership, FK, `workspace_id`, constraints, indexes, states and migration effects. Every business aggregate has UUID `id` unless natural composite key indicated; `workspace_id` belongs in all unique/foreign constraints when tenant-scoped. All mutations check active tenant/permission before row update. Primary history/ledger tables are append-only unless specifically noted otherwise.

## Aggregate ownership and exact logical entities

### Smart Process Automation

**SPA Types and Capabilities** (`Smart-Process-Automation/spa-types-capabilities.md`)

- spa_entity_types: id UUID, workspace_id UUID, code uppercase 2..64, name 1..160, plural_name 1..160, placement CRM|AUTOMATION, status DRAFT|ACTIVE|ARCHIVED|DELETION_PENDING, schema_version integer, created_by_user_id, created_at, updated_at, deleted_at, version bigint.
- spa_capabilities: (workspace_id, type_id, capability_key) unique; capability_key PIPELINES|KANBAN|AUTOMATION|CLIENT|PRODUCTS|DOCUMENTS|OBSERVERS|TASKS|CALENDAR|RECURRENCE|RECYCLE_BIN|NUMBERING|ACTIVITIES; enabled boolean; configuration_json validated per key.

**SPA Fields, Schema Drafts and Publication** (`Smart-Process-Automation/spa-fields-schema-versions.md`)

- spa_field_definitions: workspace_id,type_id,code,name,field_type TEXT|TEXTAREA|INTEGER|DECIMAL|BOOLEAN|DATE|DATETIME|LIST|MULTI_LIST|EMAIL|PHONE|URL|MONEY|USER|CRM_REF|FILE|SPA_REF; is_required,is_multiple,is_active,is_searchable,default_json,validation_json,visibility_json,version.
- spa_field_options: workspace_id,field_id,code,label,sort_order,is_active; unique(field_id,code).
- spa_schema_versions: workspace_id,type_id,version_number,published_at,published_by,snapshot_json,checksum; unique(type_id,version_number), immutable after publication.
- spa_schema_migration_jobs: old_version,new_draft_id,field_mapping_json,conversion_failures,processed_count,status; never silently discard values.
- spa_unique_constraints: workspace_id,type_id,name,field_codes_json,active; uniqueness also scoped to type.

**SPA Items, Assignments and Item History** (`Smart-Process-Automation/spa-items.md`)

- spa_items: id,workspace_id,type_id,item_number,title,assigned_user_id,company_id?,my_company_id?,pipeline_id?,stage_id?,status ACTIVE|COMPLETED|TRASHED,version bigint,schema_version,created_by_user_id,updated_by_user_id,created_at,updated_at,deleted_at,trashed_at,purge_after.
- spa_item_field_values: workspace_id,item_id,field_id,value_text/value_number/value_date/value_boolean/value_json, schema_version; indexed according to field config.
- spa_item_observers: unique(workspace_id,item_id,user_id); spa_item_external_keys: unique(workspace_id,type_id,source_system,external_id).

**SPA Pipelines, Stages, Kanban and Transitions** (`Smart-Process-Automation/spa-pipelines-stages.md`)

- spa_pipelines: workspace_id,type_id,id,code,name,is_default,sort_order,status,version; unique(type_id,code), at most one active default per Type.
- spa_stages: workspace_id,pipeline_id,id,code,name,semantic PROGRESS|SUCCESS|FAILURE,is_default,sort_order,status,version.
- spa_stage_transition_rules: workspace_id,from_stage_id,to_stage_id,allowed_roles_json,conditions_json; spa_stage_history: item_id,old/new pipeline/stage,actor,entered_at,exited_at.

**SPA Relations, Shared Business Bindings and Views** (`Smart-Process-Automation/spa-relations.md`)

- spa_relation_definitions: workspace_id,type_id,name,code,target_type,target_subtype_id?,cardinality ONE|MANY,is_required,configuration_json.
- spa_item_relations: workspace_id,source_item_id,target_type,target_id,relation_definition_id,relation_type,is_primary; unique(source_item_id,relation_definition_id,target_type,target_id).
- spa_form_layouts: workspace_id,type_id,id,name,context CREATE|DETAIL|EDIT,version; sections and ordered field references; user preferences for List/Kanban views.

**SPA Scoped Roles, Stage/Field Access and Schema Security** (`Smart-Process-Automation/spa-permissions.md`)

- spa_type_role_policies: workspace_id,type_id,role_id,action,scope NONE|OWN|DEPARTMENT|DEPARTMENT_TREE|TEAM|ALL; unique(type_id,role_id,action).
- spa_stage_permissions: workspace_id,type_id,pipeline_id,stage_id,role_id,action,scope; spa_field_permissions: workspace_id,field_id,subject_type,subject_id,can_view,can_edit.
- All policy changes append immutable configuration history and increment auth permission version/cache epoch.

**SPA Numbering, Recurrence and Idempotent Generation** (`Smart-Process-Automation/spa-numbering-recurrence.md`)

- spa_numbering_schemes: workspace_id,type_id,prefix_template,padding,reset_policy NEVER|YEARLY|MONTHLY,period_key,next_value bigint,version; sequence locked per type+period.
- spa_recurrence_templates: workspace_id,type_id,template_item_id?,item_payload_json,rule_id,is_active,created_by_user_id.
- spa_recurrence_rules: workspace_id,type_id,frequency DAILY|WEEKLY|MONTHLY|YEARLY|CUSTOM,timezone,starts_at,ends_at?,interval,by_day_json?,max_instances?.
- spa_recurrence_instances: workspace_id,rule_id,scheduled_for,item_id,created_at; unique(workspace_id,rule_id,scheduled_for).

**SPA Import, Export, Recycle and Retention** (`Smart-Process-Automation/spa-import-export-lifecycle.md`)

- spa_import_jobs: workspace_id,type_id,id,mode CREATE_ONLY|UPSERT_BY_EXTERNAL_KEY,mapping_json,status,source_file_id,created_by,totals_json.
- spa_import_rows: workspace_id,job_id,row_number,external_source,external_id,status,error_codes_json,item_id; unique(job_id,row_number).
- spa_export_jobs: workspace_id,type_id,scope_snapshot_json,requested_by,status,download_file_id,expires_at.
- spa_purge_jobs: workspace_id,type_id,item_ids_json,status,legal_hold_checked_at,attempt_count.

### Workflows & Business Processes

**Workflow Definitions, Versions and Publication** (`Workflows-Business-Processes/workflow-definitions-versions.md`)

- workflow_definitions: workspace_id,id,code,name,type SEQUENTIAL|STATUS_DRIVEN,status DRAFT|ACTIVE|PAUSED|ARCHIVED,bound_entity_type,bound_entity_type_id?,current_version_id?,concurrency_mode,run_as,version,created_by_user_id.
- workflow_versions: workspace_id,id,definition_id,version_number,status DRAFT|PUBLISHED|SUPERSEDED|ARCHIVED,definition_json,checksum,published_at,published_by; unique(definition_id,version_number); PUBLISHED immutable.
- workflow_parameter_definitions: workspace_id,version_id,code,typed_schema_json,required,default_json; workflow_start_conditions: workspace_id,definition_id,event_type,condition_json,enabled,priority.

**Workflow Graph, Designer and Safe Expressions** (`Workflows-Business-Processes/workflow-designer-nodes.md`)

- workflow_nodes: workspace_id,version_id,id,node_key,type,configuration_json,position_x,position_y; unique(version_id,node_key).
- workflow_edges: workspace_id,version_id,id,from_node_id,to_node_id,edge_type,condition_json,sort_order.
- variables/parameters/constants: code,datatype TEXT|NUMBER|MONEY|BOOLEAN|DATE|DATETIME|USER|ENTITY_REF|JSON_TYPED,typed_validation_json; secrets are connection references only.

**Workflow Executions, Tokens, Dispatch and Recovery** (`Workflows-Business-Processes/workflow-executions.md`)

- workflow_executions: workspace_id,id,definition_id,version_id,entity_type,entity_id,run_as,started_by_type,started_by_id,status QUEUED|RUNNING|WAITING|SUSPENDED|COMPLETED|FAILED|CANCELLED|TERMINATED|TIMED_OUT,result_code,result_json,started_at,completed_at,version bigint.
- workflow_node_executions: workspace_id,execution_id,node_id,iteration_number,attempt_count,status,input_json,output_json,error_code,lease_owner,lease_until; unique(execution_id,node_id,iteration_number,activation_key).
- workflow_execution_tokens: execution_id,branch_key,node_key,status,join_group_id,version; workflow_start_requests: unique(workspace_id,definition_id,idempotency_key).

**Human Approvals, Information Requests and Delegation** (`Workflows-Business-Processes/human-approvals.md`)

- workflow_human_assignments: workspace_id,id,execution_id,node_run_id,assignment_type APPROVAL|REQUEST_INFO,status PENDING|COMPLETED|CANCELLED|EXPIRED,policy ANY|ALL|QUORUM,quorum_count?,due_at?,result_json.
- workflow_approval_votes: unique(assignment_id,assignee_user_id),decision APPROVE|REJECT|REQUEST_CHANGES,decided_at,comment,acted_by_user_id.
- workflow_delegations: assignment_id,from_user_id,to_user_id,actor_user_id,reason,created_at; escalation rules per node and time offset.

**Durable Timers, Events, Parallelism and Bounded Loops** (`Workflows-Business-Processes/timers-events-loops.md`)

- workflow_timers: workspace_id,execution_id,node_run_id,type ABSOLUTE|RELATIVE|WORKDAY_AWARE,scheduled_for,status PENDING|FIRED|CANCELLED|PAUSED,remaining_seconds,unique_resume_key.
- workflow_event_subscriptions: workspace_id,execution_id,node_run_id,event_type,correlation_key,status PENDING|FULFILLED|CANCELLED,expires_at; unique(execution_id,node_run_id,event_type,correlation_key).
- workflow_parallel_joins: workspace_id,execution_id,join_node_key,join_mode ALL|ANY|QUORUM|required_count,completed_branch_tokens; constraints protect duplicate token accounting.

**Subworkflows, Error Routing and Saga Compensation** (`Workflows-Business-Processes/subworkflows-compensation.md`)

- workflow_compensation_actions: workspace_id,execution_id,node_run_id,action_type,configuration_json,status PENDING|RUNNING|SUCCEEDED|FAILED,attempt_count,idempotency_key,executed_at.
- workflow_entity_locks: unique(workspace_id,entity_type,entity_id,lock_scope),execution_id,expires_at,leased_by.
- workflow_child_executions: parent_execution_id,child_execution_id,wait_for_completion,result_mapping_json; ancestry index detects recursion.

**Workflow Domain Actions, HTTP/Webhooks and Secrets** (`Workflows-Business-Processes/workflow-integrations.md`)

- workflow_action_registry: action_code,allowed_input_schema,required_permission,side_effect_class,timeout_policy,retry_policy; immutable platform-defined registry.
- workflow_action_invocations: workspace_id,execution_id,node_run_id,action_code,request_hash,idempotency_key,status,domain_result_ref; unique(node_run_id,action_code,idempotency_key).
- workflow_external_callbacks: workspace_id,execution_id,node_run_id,correlation_token_hash,expires_at,received_at,payload_hash,status.

**Workflow Security, Templates and Execution Governance** (`Workflows-Business-Processes/workflow-security-runtime.md`)

- workflow_templates: workspace_id,id,name,category,definition_snapshot_json,status,owner_user_id,version,created_at.
- workflow_runtime_policies: workspace_id,concurrency_limits,loop_limits,retention_days default365,redaction_config,version.
- workflow_comments_bindings: workspace_id,execution_id,shared_discussion_id (Communication/Timeline owns comments).

### Inventory & Warehouses

**Warehouses, Locations and Scoped Access** (`Inventory-Warehouses/warehouses-locations.md`)

- inventory_warehouses: id,workspace_id,code,name,warehouse_type PHYSICAL|STORE|FULFILLMENT|RETURNS|DAMAGED|TRANSIT|VIRTUAL,status ACTIVE|INACTIVE|ARCHIVED,is_default,timezone,address_id?,phone?,version,created_at.
- inventory_locations: workspace_id,id,warehouse_id,parent_location_id?,code,name,type AISLE|RACK|BIN|ZONE,status; unique(warehouse_id,parent_location_id,code).
- inventory_warehouse_permissions: workspace_id,warehouse_id,role_id,action,scope; inventory_warehouse_priorities: warehouse_id,priority,region_code.

**Stock Availability, Immutable Ledger and Rebuild** (`Inventory-Warehouses/stock-balances-movements.md`)

- inventory_movements: id,workspace_id,warehouse_id,location_id?,product_id,variant_id?,document_id,document_line_id,source_type,source_id,quantity_delta NUMERIC(24,6),unit_cost NUMERIC(24,6),total_cost NUMERIC(24,6),movement_type,occurred_at,created_at; append-only.
- inventory_balances: unique(workspace_id,warehouse_id,inventory_key,location_id?),on_hand NUMERIC(24,6),reserved NUMERIC(24,6),version bigint,updated_at; available = on_hand-reserved.
- inventory_balance_snapshots: workspace_id,warehouse_id,inventory_key,as_of_date,on_hand,reserved,valuation_total.

**Inventory Documents, Approval, Posting and Reversal** (`Inventory-Warehouses/inventory-documents.md`)

- inventory_documents: id,workspace_id,number,document_type STOCK_RECEIPT|STOCK_ADJUSTMENT|TRANSFER|SALES_ORDER|CUSTOMER_RETURN|SUPPLIER_RETURN|WRITE_OFF,status DRAFT|PENDING_APPROVAL|APPROVED|PROCESSED|CANCELLED,source_warehouse_id?,destination_warehouse_id?,currency,source_entity_type?,source_entity_id?,version,processed_at,processed_by.
- inventory_document_lines: id,workspace_id,document_id,product_id,variant_id?,quantity NUMERIC(24,6),unit_cost NUMERIC(24,6),write_off_reason?,source_location_id?,target_location_id?,line_number.
- inventory_document_operations: unique(workspace_id,document_id,operation_type,idempotency_key),result_json,status; approvals record actor/threshold/version.

**Stock Reservations, Backorders, Expiry and Allocation** (`Inventory-Warehouses/reservations.md`)

- inventory_reservations: id,workspace_id,source_type DEAL|ORDER|INVOICE|MANUAL|SPA_ITEM,source_id,warehouse_id,product_id,variant_id?,quantity NUMERIC(24,6),fulfilled_quantity,released_quantity,status ACTIVE|PARTIALLY_FULFILLED|FULFILLED|RELEASED|EXPIRED|CANCELLED,reserved_at,expires_at,version.
- inventory_reservation_allocations: reservation_id,warehouse_id,location_id?,quantity; unique per reservation/warehouse/location.

**Stocktake Sessions, Snapshots and Reconciliation** (`Inventory-Warehouses/stocktakes.md`)

- stocktake_sessions: id,workspace_id,warehouse_id,location_id?,status DRAFT|COUNTING|RECONCILING|POSTED|CANCELLED,as_of_at,started_by,completed_by,version.
- stocktake_lines: id,workspace_id,session_id,product_id,variant_id?,expected_qty,expected_balance_version,counted_qty?,counted_by?,counted_at?,variance_qty,adjustment_document_line_id?.
- stocktake_count_history: count attempts,actor,quantity,timestamp; historical counts remain.

**Inventory FIFO and Average Cost Valuation** (`Inventory-Warehouses/costing.md`)

- inventory_cost_layers: workspace_id,warehouse_id,inventory_key,source_document_line_id,original_qty,remaining_qty,unit_cost,currency,received_at; FIFO ordered by received_at,id.
- inventory_cost_allocations: movement_id,layer_id,quantity,unit_cost,total_cost; unique(movement_id,layer_id).
- inventory_average_costs: unique(workspace_id,warehouse_id,inventory_key,currency),qty,total_value,average_cost.
- inventory_costing_migrations: workspace_id,from_method,to_method,status,preview_report_file_id,approved_by,applied_at,opening_snapshot_ref.

**Barcodes, Serial and Batch Tracking** (`Inventory-Warehouses/serial-batch-barcode.md`)

- product_barcodes: workspace_id,id,product_id,variant_id?,barcode_type EAN13|UPC|CODE128|QR|CUSTOM,value,is_primary; unique(workspace_id,value).
- inventory_serial_numbers: workspace_id,id,product_id,variant_id?,serial_number,warehouse_id?,status IN_STOCK|RESERVED|SOLD|RETURNED|DAMAGED|WRITTEN_OFF; unique(workspace_id,inventory_key,serial_number).
- inventory_batches: workspace_id,id,product_id,variant_id?,batch_number,manufactured_at?,expires_at?,status; unique(workspace_id,inventory_key,batch_number).

**Inventory Policies, Reorder Alerts and Controlled Reset** (`Inventory-Warehouses/inventory-policies-automation.md`)

- inventory_settings: workspace_id primary,is_enabled,costing_method,allow_negative_stock default false,allow_backorder_reservations default false,default_reservation_days default 3,default_warehouse_id,default_allocation_strategy,version.
- inventory_reorder_settings: unique(workspace_id,warehouse_id,inventory_key),reorder_point,reorder_quantity,safety_stock,preferred_vendor_id?.
- inventory_low_stock_alerts: workspace_id,warehouse_id,inventory_key,threshold_at,open_since,resolved_at; dedupe active alerts.
- inventory_numbering_schemes: workspace_id,document_type,prefix_template,padding,reset_policy,period_key,next_value.

### Online Store & Commerce

**Stores, Storefronts and Catalog Publication** (`Online-Store-Commerce/stores-storefronts.md`)

- commerce_stores: id,workspace_id,code,name,status DRAFT|ACTIVE|SUSPENDED|ARCHIVED,default_currency,timezone,default_warehouse_id?,catalog_id,reservation_timing CART|ORDER_PLACED|PAYMENT_AUTHORIZED|PAYMENT_PAID|MANUAL default ORDER_PLACED,deal_creation_policy NEVER|ALWAYS|ONLY_NEW_CUSTOMER|MANUAL_REVIEW default ALWAYS,version.
- commerce_storefronts: workspace_id,store_id,id,type WEB|HEADLESS|MOBILE|SOCIAL|EMBEDDED,slug,domain?,status DRAFT|PUBLISHED|SUSPENDED,configuration_json,published_at.
- commerce_product_publications: workspace_id,store_id,product_id,variant_id?,published,available_from?,available_until?,seo_slug,version; unique(store_id,inventory_key).

**Public Cart, Checkout, Server Prices and Idempotency** (`Online-Store-Commerce/carts-checkout.md`)

- commerce_carts: id,workspace_id,store_id,session_token_hash,status ACTIVE|CHECKOUT|CONVERTED|ABANDONED|EXPIRED,currency,created_at,last_activity_at,expires_at,version; session secret shown once to holder.
- commerce_cart_items: workspace_id,cart_id,product_id,variant_id?,quantity NUMERIC(18,6),selected_options_json,version; unique(cart_id,inventory_key,options_hash).
- commerce_checkout_sessions: id,workspace_id,cart_id,customer_snapshot,address_snapshot,delivery_rate_id?,payment_method_id?,quote_hash,expires_at,status DRAFT|QUOTED|ORDERED|EXPIRED,order_id?,version; unique(cart_id,successful_conversion_key).

**Commerce Customers, Orders, Snapshots and History** (`Online-Store-Commerce/customers-orders.md`)

- commerce_customer_accounts: workspace_id,store_id,id,email_normalized,identity_auth_id?,status ACTIVE|DISABLED; identity separate from Workspace employee membership.
- commerce_orders: id,workspace_id,store_id,order_number,customer_account_id?,crm_contact_id?,crm_company_id?,crm_deal_id?,currency,subtotal,discount_total,tax_total,delivery_total,grand_total NUMERIC(18,2),payment_status,fulfillment_status,order_status,source_checkout_session_id unique,version,created_at,cancelled_at.
- commerce_order_lines: workspace_id,order_id,product_id,variant_id?,sku_snapshot,title_snapshot,quantity,unit_price,tax_rate_snapshot,discount_snapshot,line_total,currency; immutable once Order placed.
- commerce_order_addresses/customer_snapshots hold historical values independent of live CRM records; status history append-only.

**Pricing, Promotions, Coupons and Tax Snapshot** (`Online-Store-Commerce/pricing-discounts-taxes.md`)

- commerce_discount_rules: workspace_id,store_id,id,code,name,kind PERCENT|FIXED|FREE_SHIPPING,priority,stack_group,combinable,eligibility_json,usage_limit?,per_customer_limit?,start_at?,end_at?,active,version.
- commerce_coupons: workspace_id,store_id,id,code_hash_or_normalized,rule_id,usage_limit,per_customer_limit,expires_at,active; redemption unique(order_id,coupon_id).
- commerce_tax_rules: workspace_id,store_id,id,region,category,tax_rate NUMERIC(10,6),price_basis INCLUSIVE|EXCLUSIVE,effective_from,effective_to?; historical snapshot on order line.

**Commerce Payments, Authorization, Capture and Disputes** (`Online-Store-Commerce/payments.md`)

- payments: workspace_id,id,order_id,provider,provider_transaction_id?,amount,currency,status CREATED|PENDING|AUTHORIZED|PARTIALLY_CAPTURED|PAID|FAILED|VOIDED|PARTIALLY_REFUNDED|REFUNDED,authorized_amount,captured_amount,refunded_amount,version.
- commerce_order_payments: order_id,payment_id,allocated_amount; payment_attempts: provider_attempt_id,kind AUTHORIZE|CAPTURE|SALE|VOID,status.
- payment_provider_events: unique(provider,provider_event_id),signature_verified,payload_hash,processed_at,status.
- commerce_payment_disputes: workspace_id,payment_id,provider_dispute_id,status OPEN|EVIDENCE_REQUIRED|SUBMITTED|WON|LOST,opened_at,resolved_at.

**Delivery Methods, Shipment Lifecycle and Fulfillment** (`Online-Store-Commerce/delivery-shipments.md`)

- commerce_delivery_services: workspace_id,store_id,id,type COURIER|PICKUP|POSTAL|SAME_DAY|THIRD_PARTY|DIGITAL|CUSTOM,provider_code?,active.
- commerce_delivery_rates: store_id,service_id,conditions_json,price NUMERIC(18,2),currency,estimated_days_min/max,active.
- commerce_shipments: workspace_id,id,order_id,warehouse_id,delivery_service_id,status NEW|PROCESSING|READY|SHIPPED|IN_TRANSIT|DELIVERED|FAILED|RETURNED|CANCELLED,tracking_number?,external_shipment_id?,shipped_at?,delivered_at?,version.
- commerce_shipment_items: unique(shipment_id,order_line_id),quantity,inventory_document_line_id?; sum shipment qty <= order line ordered qty minus returns.

**Returns, Disposition, Refunds and Financial Approval** (`Online-Store-Commerce/returns-refunds.md`)

- commerce_returns: workspace_id,id,order_id,status REQUESTED|APPROVED|REJECTED|IN_TRANSIT|RECEIVED|INSPECTING|COMPLETED|CANCELLED,reason,requested_at,approved_by?,received_at?,version.
- commerce_return_lines: workspace_id,return_id,order_line_id,quantity,disposition SELLABLE|DAMAGED|REPAIR|REJECT?,received_qty,inventory_return_document_line_id?; sum returns <= delivered/unreturned qty.
- refunds: workspace_id,id,order_id,payment_id?,return_id?,amount,currency,status REQUESTED|PENDING_APPROVAL|APPROVED|PROCESSING|SUCCEEDED|FAILED|CANCELLED,provider_refund_id?,version.
- commerce_refund_approvals: refund_id,threshold_policy_snapshot,requested_by,approved_by,decision,reason,decided_at.

**Commerce CRM/Inventory Integration, Cart Abandonment and Events** (`Online-Store-Commerce/crm-inventory-automation.md`)

- commerce_crm_bindings: workspace_id,order_id,crm_contact_id?,crm_company_id?,crm_deal_id?,link_policy,link_status PENDING|LINKED|FAILED,last_error_code; unique(order_id,linked_type).
- commerce_order_reservation_bindings: workspace_id,order_id,order_line_id,reservation_id,status; unique(order_line_id,reservation_id).
- commerce_abandoned_cart_jobs: workspace_id,cart_id,eligible_at,emitted_at?,status; unique(cart_id,inactivity_epoch).

## Cross-aggregate relational constraints

1. Every child (`item_field_values`, `workflow_node_executions`, `inventory_document_lines`, `commerce_order_lines`, etc.) uses a Workspace-consistent FK `(workspace_id,parent_id) -> (workspace_id,id)`, not only a globally unique UUID with a missing tenant check.
2. All active record uniqueness per source contracts; include partial index conditions for soft-deleted records and design documented conflict policy for code re-use. SPA field codes/type codes, workflow def codes, warehouse codes, store codes, storefront slugs, provider external refs and barcode/serial identifiers must be collision-safe.
3. Inventory balance unique `(workspace_id,warehouse_id,inventory_key,location_key)`. `inventory_key` is Variant if product has variants, else Product. Null location normalized to a designated key in unique constraint/index; do not accidentally permit multiple null-location balance rows. Quantity precision `NUMERIC(24,6)`, money uses repository currency-specific decimal rounding policy.
4. Inventory movements and processed Inventory Document lines cannot be updated or hard-deleted through ordinary APIs, including stale admin endpoints; enforce via immutable service layer and DB triggers/role restrictions where appropriate. Cost allocations are audit-linked to movement.
5. Workflow published versions are write-protected (immutable graph/version rows). Instance version FK fixed to initial version. Unique start idempotency `(workspace_id,definition_id,idempotency_key)`; unique node-run dedupe includes execution/node/activation/iteration; timers/events use unique resume keys.
6. Checkout session can convert to at most one successfully placed Order (unique `source_checkout_session_id` when set). Provider payment/refund/webhook IDs have scoped unique indexes preventing duplicate financial effects. Total successful applied refunds never exceed captured net payment.
7. Cart tokens, callback tokens, provider secrets stored as cryptographically secure hashes/secure credential references; no raw PAN/CVV or secret body in history.
8. Global `audit_events` and shared `outbox_events` are reused, not new parallel audit systems; domain history tables are specialized views/evidence.

## Atomic transaction contracts

- SPA Item create: lock Type schema/number sequence → validate current version and typed field values → allocate number → insert Item/values/relations → Item history → Audit where relevant → Outbox → COMMIT.
- Workflow start: lock concurrency key/idempotency → bind immutable published version and principal → create execution/start token/variables → Outbox → COMMIT; dispatch async after commit. Each node checkpoint commits before queue ACK. Leases and idempotent effects recover after process restart.
- Inventory post: lock Document → validate DRAFT/APPROVED and permissions across all Warehouses → lock all affected balance rows deterministic order → validate stock/approval, calculate costing → write immutable movements+allocations → update balances → status PROCESSED → Audit/outbox → COMMIT. Failure rolls back both transfer legs and all events.
- Inventory reserve: lock Warehouse SKU balances → availability check (backorder policy separately) → insert/modify reservation and reserved projection → Outbox → COMMIT. Fulfillment associates a unique processed sale document.
- Commerce Order: lock checkout/idempotency and coupon usage → validate quote and stock; reserve via Inventory domain service within local transaction where possible, or saga with explicit pending state/compensation → write snapshots, order, coupon redemption, history/outbox → COMMIT. Never publish a falsely confirmed paid/fulfilled Order on failure.
- Commerce payment/refund/ship external orchestration uses durable Saga state/unique provider IDs; no pretend distributed DB transaction. Payment confirmed from verified provider truth; Shipment SHIPPED only after successful Inventory sale processing or controlled consistency checkpoint.

## Migration policy

Use forward-only safe migrations with data backfill for existing tenants. Review large-table indexes/concurrent index creation, FK validation, precision changes, non-null migrations, schema version changes and possible failed provider states. Never wipe data or reset balances to force tests to pass. Include rollback/recovery strategy for each risky migration. CI runs migrations on clean database and representative existing schema. All DB writes from tests use disposable test Workspace and provider simulator.
