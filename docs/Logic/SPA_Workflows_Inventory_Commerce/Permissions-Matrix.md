# Permissions, Public Tokens and Security Matrix

**General model:** effective authorization = feature entitlement ∩ authenticated principal API scopes ∩ active Workspace membership ∩ role/action scope ∩ resource condition/ACL. SPA also checks stage and field policy; Inventory checks document type **and every Warehouse**; Workflow checks run-as principal and underlying target. `PUBLIC_SCOPED` and `CUSTOMER_SESSION` are special narrowly scoped identities, not arbitrary Workspace membership. Services implement backend guards on every action.

| Domain | Read permissions | Mutation privileges | High-risk separation |
|---|---|---|---|
| SPA | `SPA.TYPE.READ`, `SPA.ITEM.READ`, `SPA.SCHEMA.READ` | `SPA.TYPE.MANAGE`, `SPA.SCHEMA.MANAGE`, `SPA.ITEM.CREATE/UPDATE/STAGE_CHANGE/ASSIGN`, `SPA.RECURRENCE.MANAGE` | `SPA.SCHEMA.PUBLISH`, `SPA.PERMISSION.MANAGE`, `SPA.ITEM.HARD_DELETE`, `SPA.ITEM.EXPORT` |
| Workflow | `WORKFLOW.VIEW`, `WORKFLOW.EXECUTION_VIEW`, `WORKFLOW.LOG_VIEW`, `WORKFLOW.ASSIGNMENT_VIEW` | `WORKFLOW.DESIGN`, `WORKFLOW.START`, `WORKFLOW.ASSIGNMENT_DECIDE`, `WORKFLOW.CANCEL_OWN` | `WORKFLOW.PUBLISH`, `WORKFLOW.EXECUTION_ADMIN`, `WORKFLOW.SECURE_RUNAS_MANAGE`, `WORKFLOW.ASSIGNMENT_DELEGATE` |
| Inventory | `INVENTORY.WAREHOUSE_READ`, `INVENTORY.STOCK_READ`, `INVENTORY.DOCUMENT_READ`, `INVENTORY.RESERVATION_READ` | `INVENTORY.DOCUMENT_CREATE/EDIT`, `INVENTORY.RESERVATION_CREATE`, `INVENTORY.STOCKTAKE_COUNT` | `INVENTORY.DOCUMENT_APPROVE/PROCESS/REVERSE`, `INVENTORY.COSTING_MIGRATE`, `INVENTORY.RESET`, `INVENTORY.PERMISSION_MANAGE` |
| Commerce | `COMMERCE.STORE_VIEW`, `COMMERCE.ORDER_VIEW`, `COMMERCE.PAYMENT_VIEW`, `COMMERCE.RETURN_VIEW` | `COMMERCE.STORE_MANAGE`, `COMMERCE.ORDER_UPDATE`, `COMMERCE.SHIPMENT_MANAGE`, `COMMERCE.RETURN_CREATE` | `COMMERCE.REFUND_CREATE`, `COMMERCE.REFUND_APPROVE`, `COMMERCE.REFUND_PROCESS`, `COMMERCE.PAYMENT_CAPTURE`, `COMMERCE.TAX_MANAGE` |

**Scope:** OWN, DEPARTMENT, DEPARTMENT_TREE, TEAM, ALL; NONE denies. No roles get permissions merely due to role *name*; seed permissions via organization policy. `SPA ITEM READ` may use observer-derived scoped read, but confidential fields remain filtered. Workflow start doesn't grant Workflow designer or target resource write access. `INVENTORY.DOCUMENT_PROCESS` must intersect Warehouse read/write access for both legs. REFUND_APPROVE must not be assumed from ORDER_UPDATE.

**Error semantics:** unauthenticated employee routes 401, authenticated missing capability 403, inaccessible other-Workspace/private resource IDs 404 or platform's existing non-enumerating equivalent. Expired public cart token yields generic invalid/expired response, does not reveal Store/Cart owner. Provider invalid signatures do not mutate state.

**Public security:** Store slug resolves only published Store; opaque cart/checkout token stored as hash; rate-limit coupon and Checkout/IP+store fingerprint. Customer session is separate from employee. No public warehouse addresses/cost/stock counts, payment provider credentials or CRM private details. Workflow public callbacks require scoped signed token/expiry/nonce/replay guard. Per-user/service/API permission caches invalidate after policy changes.
