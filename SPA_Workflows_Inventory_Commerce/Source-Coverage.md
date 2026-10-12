# Source Coverage and Interpretation Register

## Source-first inputs used

1. **TrueCRM — Product Requirements Document (PRD)**, original user Project attachment. Read relevant tabs: `21 - Smart Processes`, `22 - Workflows`, `23 - Inventory`, `24 - Online Store`; platform tabs Users/Auth, Workspace Permissions, CRM, Catalog, Automation, Payments, Import/Export/Integrations, Platform Services.
2. **TrueCRM — Business Requirements Document (BRD)**, original user Project attachment. Read corresponding domain business objectives, rules, actor categories and risk/acceptance expectations; in particular stock ledger, saga/retries, split commerce lifecycles.
3. **TrueCRM — System Architecture Document - Complete**, original Project attachment. Relevant tabs 21–24 plus 00/01/02/07/08/09/14/30; authoritative modular-monolith ownership, Postgres/Redis/jobs/outbox, module entities, service boundaries and integration security.
4. **bitrix24_smart_process_automation_architecture.md**, Project architecture. Metadata-driven SPA Types/Items, pipelines/stages, schema/field safety, recurrence, permissions, shared CRM activities and relations.
5. **bitrix24_workflows_business_processes_architecture.md**, Project architecture. Durable version-pinned Workflow execution, designer nodes, approval, loops/events/timers, retries, run-as, subflows/compensation, logs. Note: available local materialized source excerpt was partial; earlier Project file retrieval exposed core architecture and required rules. Source coverage uses those retrieved sections and the official TrueCRM PRD/BRD/Architecture rather than assuming unknown lines.
6. **bitrix24_inventory_management_warehouses_architecture.md**, Project architecture. Warehouses/locations, documents, append-only movements, balances/reservations, FIFO/AVERAGE costing, restock, permissions, stocktake, serial/batch/barcodes as extension.
7. **bitrix24_online_store_commerce_architecture.md**, Project architecture. Stores vs Storefronts, published shared Catalog, secure cart/checkout, separate Orders/Payments/Shipments/Inventory/Return/Refund, customer CRM bindings, promotions and delivery.
8. **TrueCRM_Developer_UIUX_Project_Plan.xlsx**, Project backlog. Modules 21–24 tasks for design handoff, DRD, database, backend/frontend, integration and QA. The pack is an implementation contract, not a substitute for approved Figma screens.
9. **SKILL.md**, Project interview method, followed across Q1–Q66 and Shared Understanding Gate; user confirmed ZIP generation.
10. **TrueAgent_Auth_Module_Codex_Pack(1).zip**, attached structural reference. Studied folder layout, `Agent.md`, module specifications, README/manifest and contract tests. Structural philosophy only; no unrelated Auth/Partner business rules copied.
11. **TrueCRM_Codex_Pack.zip**, previous generated collaboration pack. Reused compatible common API/platform/testing philosophy and interoperability boundaries. This second pack does not duplicate Tasks/Files/Calendar/Chat implementations.
12. **Bitrix-Documentation.txt** links to https://apidocs.bitrix24.com/ and was used in previous interview rounds to validate reference behavior (e.g. CRM universal Smart Process, Workflow operations, Inventory catalog documents, ecommerce sale objects). Bitrix is behavioral reference, not literal REST namespace for TrueCRM.

## Decisions vs external reference

Q1–Q66 are explicit, user-accepted **TrueCRM decisions**; where Bitrix allows a different alternative (e.g. backorder behavior or online-store without Orders), the decisions win. Phase 2 extension points are deliberately specified but not falsely claimed as fully implemented core. Unresolved important decisions: **0**.

## Boundary notes

- Shared CRM Catalog/Products, Payment/Invoice, Integrations, Audit, Search, Notifications, Site CMS, Marketing and Workspace Security are called through existing domain interfaces, not rebuilt in Pack 2.
- This pack includes full backend/domain/API/test contracts and frontend behavior requirements where the sources are explicit; pixel-perfect frontend implementation depends on approved Figma designs and is not invented in the specification.
- The attached Project sources do not prove an existing code repository's implementation; coding agent must inspect actual repository before adapting ORM/migrations/tests and cannot invent claims of tests already run.
