# Source Map

## Authoritative TrueCRM sources

The pack was derived from the following project sources:

1. **TrueCRM — Product Requirements Document (PRD)**
   - Section 13: Duplicates, Merge & Data Quality
   - Section 14: Import, Export, API & Integrations
   - Section 15: Sales Intelligence & Attribution
   - Section 16: Analytics, Reports & Dashboards
   - Also relevant: CRM Core, Custom Fields, Forms, Platform Services, Permissions and Subscription/Billing.

2. **TrueCRM — System Architecture Document**
   - Section 13: Data Quality
   - Section 14: Import, Export, API & Integrations
   - Section 15: Sales Intelligence & Attribution
   - Section 16: Analytics, Reports & Dashboards
   - Also relevant: architecture overview, workspace/permissions, CRM Core, Platform Services and Subscription/Billing.

3. **TrueCRM — Business Requirements Document (BRD)**
   - Sections 13–16 and shared business principles.

4. **SKILL.md — grill-me**
   - Used to run the design-tree interview.
   - Six rounds completed.
   - Decisions Q1–Q74 confirmed.
   - Shared Understanding Report confirmed before this pack was generated.

5. **Bitrix-Documentation.txt**
   - Points to the official Bitrix24 REST documentation: https://apidocs.bitrix24.com/
   - Bitrix24 is used as the main product-behavior reference, not as the internal architecture.

6. **TrueAgent_Auth_Module_Codex_Pack(1).zip**
   - Used only for structural/testing philosophy:
     - `Agent.md` master execution contract
     - module Markdown specifications
     - `README.md`
     - `manifest.json`
     - intentionally failing executable Jest-style contract tests
   - Auth-specific business content was not copied into this pack.

## Official Bitrix24 behavioral references consulted

- Duplicate lookup:
  https://apidocs.bitrix24.com/api-reference/crm/duplicates/crm-duplicate-find-by-comm.html
- REST API documentation root:
  https://apidocs.bitrix24.com/
- Sales Intelligence settings / attribution window:
  https://helpdesk.bitrix24.com/open/25240632/
- Traffic sources and UTM:
  https://helpdesk.bitrix24.com/open/21498798/
  https://helpdesk.bitrix24.com/open/7843255/
- BI Builder datasets:
  https://helpdesk.bitrix24.com/open/16457718/
- BI Builder dashboard creation:
  https://helpdesk.bitrix24.com/open/19542946/
- BI Builder parameters/filters:
  https://helpdesk.bitrix24.com/open/23233254/

## Interpretation rule

When Bitrix behavior and TrueCRM differ, TrueCRM wins.

The implementation should reproduce useful product behavior while preserving TrueCRM's:
- workspace isolation,
- NestJS modular-monolith architecture,
- domain-service ownership,
- provider adapter boundaries,
- transactional outbox,
- permission model,
- audit model,
- versioned metrics/attribution,
- derived/rebuildable analytics.
