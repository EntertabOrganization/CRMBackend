# Confirmed Decision Register — Q1 to Q66

**All 66 decisions are user-confirmed. Important unresolved decisions: 0.** This is the product decisions authority. Later user-approved choices would override it.

| ID | Option | Confirmed decision |
|---|---|---|
| Q1 | **C** | Full production core, advanced extensions designed/phased |
| Q2 | **B** | Multiple pipelines per SPA type; auto default |
| Q3 | **C** | Per-SPA configurable transactional business numbering |
| Q4 | **C** | Workflow concurrency configurable, default one/definition/entity |
| Q5 | **C** | Approval ANY/ALL/QUORUM, default ALL |
| Q6 | **B** | Admin suspension pauses internal timers |
| Q7 | **C** | Cancellation uses only explicitly configured compensation |
| Q8 | **C** | Negative stock/backorder separately configurable, both false by default |
| Q9 | **C** | FIFO or Average chosen at setup, migration required after live transactions |
| Q10 | **C** | Document approval configurable by type/value |
| Q11 | **C** | Configurable warehouse allocation strategies |
| Q12 | **B** | Multiple Stores per Workspace |
| Q13 | **B** | WEB + HEADLESS storefront V1; adapters later |
| Q14 | **D** | Reservation timing per Store, default ORDER_PLACED |
| Q15 | **C** | Per-Store CRM Deal creation policy, default ALWAYS |
| Q16 | **C** | Guest checkout + optional customer account history |
| Q17 | **B** | SPA structural schema draft/validate-impact/publish lifecycle |
| Q18 | **C** | Explicit field type migration plan and conversion report |
| Q19 | **B** | Deleting SPA Item does not delete shared linked objects |
| Q20 | **B** | Recurring SPA items independent; template edits future only |
| Q21 | **C** | SPA create-only or stable-external-key upsert imports |
| Q22 | **B** | Workflow run as starter by default, scoped service principal for trusted automation |
| Q23 | **C** | Authorized auditable approval delegation |
| Q24 | **C** | Configurable approval timeout; no silent auto-approval default |
| Q25 | **C** | Bounded safe retries then visible failed/recoverable state |
| Q26 | **B** | Controlled retry failed node from persisted state |
| Q27 | **C** | Configurable parent wait/output mapping for sub-workflows |
| Q28 | **C** | Optional warehouse sub-locations; advanced WMS later |
| Q29 | **C** | Optional SKU serial/batch with advanced traceability Phase2 |
| Q30 | **C** | Reservation expiry policy default three days |
| Q31 | **C** | Stocktake uses versioned snapshot and reconciles concurrent movements |
| Q32 | **C** | Commerce CRM customer dedupe resolver/link or create policy |
| Q33 | **C** | Promotion combinability/priority/eligibility policy |
| Q34 | **C** | Tax inclusive/exclusive by Store/rule, snapshot on Order |
| Q35 | **C** | Store cancellation window, post-shipment Return rather than cancel |
| Q36 | **C** | Return physical lifecycle separate from Refund money lifecycle |
| Q37 | **C** | Metadata-defined unique SPA constraints |
| Q38 | **B** | SPA Observer default read only unless additional authorization |
| Q39 | **C** | SPA Recycle 30-day default configurable/legal hold |
| Q40 | **C** | Workflow platform ceilings and configurable lower plan/workspace limits |
| Q41 | **B** | Workflow Definition archive, historical executions preserved |
| Q42 | **C** | Structured redacted Workflow logs with access filtering |
| Q43 | **B** | Reuse shared discussion/Timeline not duplicate Workflow comments |
| Q44 | **C** | Costing policy Workspace level; controlled migration |
| Q45 | **C** | Inventory reset only privileged traceable adjustment/reversal migration |
| Q46 | **C** | Inventory low-stock emits event, automation decides actions |
| Q47 | **C** | Inventory document numbering per type transactional |
| Q48 | **C** | Payment provider/method supports auth-then-capture and immediate |
| Q49 | **C** | Shipment before full payment policy; default restrict except COD/credit |
| Q50 | **C** | Separate refund create/approve and thresholds |
| Q51 | **C** | Lightweight chargeback/dispute model V1 |
| Q52 | **C** | Abandoned cart threshold Store configurable, 2h default |
| Q53 | **C** | Order COMPLETED from fulfillment plus applicable payment conditions |
| Q54 | **B** | One Order may use many warehouse Shipments/Inventory documents |
| Q55 | **C** | External API credentials same domain guards/entitlements |
| Q56 | **C** | Public published-Store context, opaque cart/checkout tokens |
| Q57 | **C** | Domain outbox events, shared Integration webhook delivery |
| Q58 | **C** | Secrets in shared Integration Credential store, referenced by ID |
| Q59 | **C** | Risk-specific policy rate limits through shared platform service |
| Q60 | **C** | No normal destructive Order deletion; cancel/archive/retention |
| Q61 | **D** | Workflow execution history retention configurable, default 1y/legal hold |
| Q62 | **C** | Processed Inventory documents/ledger no normal hard-delete |
| Q63 | **C** | Central Audit critical/security/financial config; domain history high-volume |
| Q64 | **B** | Standard Idempotency-Key for retry-sensitive commands |
| Q65 | **C** | Asynchronous bulk jobs with row-level status/errors |
| Q66 | **C** | Full contract pack plus controller inventory and executable tests |

## Normative relationship

All applicable decisions bind the matching module specification. If a codebase implementation differs, surface the conflict and migrate carefully; do not silently invent an incompatible business rule. The previous TrueCRM Collaboration pack's compatible API/platform rules also remain in force, but module-specific semantics in this pack take priority for these four modules.
