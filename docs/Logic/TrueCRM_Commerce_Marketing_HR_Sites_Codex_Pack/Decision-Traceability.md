# Approved Decision → Implementation Traceability

All 76 items were answered with the recommended option and confirmed in the final Shared Understanding Report. This table maps each approved business decision to the primary owned specification. Many decisions also apply to cross-cutting tests and `Agent.md`.

| Decision | Confirmed requirement | Primary implementation file |
|---|---|---|
| Q1 | Complete scope staged Core V1/Advanced | `Shared-Contracts/11-release-phases-and-dependencies.md` |
| Q2 | Global/multi-country configurable market policies | `Shared-Contracts/03-data-model-and-retention.md` |
| Q3 | B2C and basic B2B selling | `OnlineStore-Commerce/04-carts-and-checkout.md` |
| Q4 | Physical, service and digital products | `OnlineStore-Commerce/02-product-publication-and-pricing.md` |
| Q5 | Meta/Google audience sync and performance imports, not direct ad editing | `Marketing-Campaigns/10-ad-platforms-and-repeat-sales.md` |
| Q6 | Configurable risk/size/channel-based marketing approvals | `Marketing-Campaigns/06-campaigns-and-approvals.md` |
| Q7 | HR employee operations; no payroll or full recruitment/performance suite | `HR-TimeTracking/01-employee-profiles.md` |
| Q8 | Optional IP/network, GPS and QR attendance checks | `HR-TimeTracking/03-clock-and-breaks.md` |
| Q9 | Configurable leave accrual, balance, carryover, holidays, approvals | `HR-TimeTracking/07-leave-types-balances.md` |
| Q10 | Sites pages and blog/news CMS entries | `Sites-LandingPages/02-pages-navigation-and-cms.md` |
| Q11 | AI full site drafts and campaign help with human review | `Sites-LandingPages/10-ai-generation-and-templates.md` |
| Q12 | Authorized custom CSS/controlled JS with security | `Sites-LandingPages/08-cookies-scripts-and-security.md` |
| Q13 | Configurable site publication approvals | `Sites-LandingPages/04-drafts-preview-and-publication.md` |
| Q14 | Stripe/XPay and offline payment methods | `OnlineStore-Commerce/06-payments-and-reconciliation.md` |
| Q15 | Pickup, delivery zones, weight rules, carrier adapters/tracking | `OnlineStore-Commerce/08-shipping-and-fulfillment.md` |
| Q16 | Configurable optional Deal creation from Order; default CRM links | `OnlineStore-Commerce/11-crm-sales-links.md` |
| Q17 | Coupons, automatic promotion rules, no loyalty wallet by default | `OnlineStore-Commerce/10-promotions-taxes-and-delivery.md` |
| Q18 | Email/SMS/messenger/voice providers with phased adapters | `Marketing-Campaigns/04-sender-and-provider-config.md` |
| Q19 | Consent by recipient/channel/purpose and legal basis | `Marketing-Campaigns/03-consent-and-suppression.md` |
| Q20 | Workspace/channel frequency cap, quiet hours, throttling | `Marketing-Campaigns/07-delivery-jobs-and-retries.md` |
| Q21 | Nurture journeys reuse Workflow engine | `Marketing-Campaigns/09-experiments-and-journeys.md` |
| Q22 | Attendance employee correction request, supervisor approval, HR override | `HR-TimeTracking/04-attendance-and-corrections.md` |
| Q23 | Overtime policy calculation/approval with no payroll | `HR-TimeTracking/06-overtime-policy.md` |
| Q24 | On/offboarding workflows coordinate Tasks, docs and access | `HR-TimeTracking/10-onboarding-offboarding-and-docs.md` |
| Q25 | Managed site hosting/subdomains/custom domains/SSL/CDN | `Sites-LandingPages/01-sites-hosting-and-domains.md` |
| Q26 | Independent localized revisions, RTL, reviewed translations | `Sites-LandingPages/05-localization-and-rtl.md` |
| Q27 | Site A/B experiments with stable assignment | `Sites-LandingPages/09-ab-experiments.md` |
| Q28 | Backorder/preorder opt-in, no fictional reservation | `OnlineStore-Commerce/07-inventory-reservations.md` |
| Q29 | Reservation TTL per store and safe expiry/release | `OnlineStore-Commerce/07-inventory-reservations.md` |
| Q30 | Pending-payment order, verified gateway callback, expiry | `OnlineStore-Commerce/06-payments-and-reconciliation.md` |
| Q31 | Individual/company payer fields and Requisites links | `OnlineStore-Commerce/04-carts-and-checkout.md` |
| Q32 | Multi-currency, tax-inclusive/exclusive and historical snapshots | `OnlineStore-Commerce/10-promotions-taxes-and-delivery.md` |
| Q33 | Platform-managed and BYO marketing provider connections | `Marketing-Campaigns/04-sender-and-provider-config.md` |
| Q34 | Normalize/dedupe contacts by channel and preference | `Marketing-Campaigns/01-segments-and-audiences.md` |
| Q35 | Marketing A/B variants and controlled winner selection | `Marketing-Campaigns/09-experiments-and-journeys.md` |
| Q36 | Unknown marketing consent ineligible where required | `Marketing-Campaigns/03-consent-and-suppression.md` |
| Q37 | Effective-dated schedule versions and history | `HR-TimeTracking/02-work-schedules-and-shifts.md` |
| Q38 | Missing work clock events become anomalies for correction | `HR-TimeTracking/03-clock-and-breaks.md` |
| Q39 | Paid leave insufficient balance blocked unless authorized override | `HR-TimeTracking/07-leave-types-balances.md` |
| Q40 | Multi-level HR approvals, delegation, escalation | `HR-TimeTracking/08-leave-requests-and-approvals.md` |
| Q41 | Draft/page/site publication, scheduled releases and rollback | `Sites-LandingPages/04-drafts-preview-and-publication.md` |
| Q42 | Shared verified domain route for websites and store/headless | `Sites-LandingPages/07-form-commerce-and-widget-blocks.md` |
| Q43 | Scripts/tracking governed by cookie/jurisdiction consent | `Sites-LandingPages/08-cookies-scripts-and-security.md` |
| Q44 | Configurable intermediate statuses plus protected Order states | `OnlineStore-Commerce/05-orders-and-amendments.md` |
| Q45 | Partial returns, inspection, refund and authorized restock | `OnlineStore-Commerce/09-returns-and-refunds.md` |
| Q46 | Optional customer portal and guest secure order links | `OnlineStore-Commerce/03-customer-identities-and-portal.md` |
| Q47 | Shared Catalog with store-specific publication/prices/categories | `OnlineStore-Commerce/02-product-publication-and-pricing.md` |
| Q48 | Imported marketing audience-only identities with validation | `Marketing-Campaigns/02-audience-imports.md` |
| Q49 | Bounce/complaint automatic suppression policy | `Marketing-Campaigns/03-consent-and-suppression.md` |
| Q50 | Pause, resume, cancel queued sends without resends | `Marketing-Campaigns/06-campaigns-and-approvals.md` |
| Q51 | Frozen template versions and content approvals | `Marketing-Campaigns/05-templates-and-content.md` |
| Q52 | Submitted/approved/locked timesheets; audited reopen | `HR-TimeTracking/05-timesheets.md` |
| Q53 | Task time separate from attendance; optional reconciliation | `HR-TimeTracking/05-timesheets.md` |
| Q54 | Partial-day/hour-based leave and holidays | `HR-TimeTracking/08-leave-requests-and-approvals.md` |
| Q55 | HR-specific confidential field/file scopes and self-service | `HR-TimeTracking/11-hr-security-retention-and-analytics.md` |
| Q56 | Shared block change requires publish | `Sites-LandingPages/03-editor-blocks-and-themes.md` |
| Q57 | Expiring revocable secure draft previews | `Sites-LandingPages/04-drafts-preview-and-publication.md` |
| Q58 | Soft-delete/recovery and redirect for website routes | `Sites-LandingPages/11-recovery-exports-and-entitlements.md` |
| Q59 | Existing Subscription entitlement engine sets module usage limits | `Shared-Contracts/11-release-phases-and-dependencies.md` |
| Q60 | Order amendments with financial/shipping history protected | `OnlineStore-Commerce/05-orders-and-amendments.md` |
| Q61 | Captured payment with no available stock -> exception/re-reserve/backorder/refund | `OnlineStore-Commerce/06-payments-and-reconciliation.md` |
| Q62 | Conversation-originated order/payment links reuse Commerce | `OnlineStore-Commerce/11-crm-sales-links.md` |
| Q63 | Bounded retry/failover same channel with verified sender | `Marketing-Campaigns/07-delivery-jobs-and-retries.md` |
| Q64 | Privacy-governed engagement; opens not reliable proof | `Marketing-Campaigns/08-engagement-and-conversions.md` |
| Q65 | Only policy-defined clock evidence; no continuous GPS | `HR-TimeTracking/03-clock-and-breaks.md` |
| Q66 | Narrative employee work reports with supervisor review | `HR-TimeTracking/09-work-reports.md` |
| Q67 | General absence free/busy view redacts reason | `HR-TimeTracking/08-leave-requests-and-approvals.md` |
| Q68 | Missing locale fallback configurable, correct SEO metadata | `Sites-LandingPages/05-localization-and-rtl.md` |
| Q69 | Broken Forms/Commerce block has honest controlled unavailable state | `Sites-LandingPages/07-form-commerce-and-widget-blocks.md` |
| Q70 | Category/jurisdiction retention, anonymization and legal holds | `Shared-Contracts/03-data-model-and-retention.md` |
| Q71 | Grace/entitlement restrictions preserve records and obligations | `Sites-LandingPages/11-recovery-exports-and-entitlements.md` |
| Q72 | Existing modules through explicit typed contracts, never duplicate production ownership | `Shared-Contracts/11-release-phases-and-dependencies.md` |
| Q73 | Separate storefront customer realm, optionally cross-store in workspace | `OnlineStore-Commerce/03-customer-identities-and-portal.md` |
| Q74 | Initial provider set Stripe, XPay, SMTP/SES, Twilio, WhatsApp, Meta/Google | `Shared-Contracts/06-provider-interfaces.md` |
| Q75 | Default configurable 15-day grace, safe published sites, checkout block | `Sites-LandingPages/11-recovery-exports-and-entitlements.md` |
| Q76 | Configurable jurisdiction-aware retention engine required before production | `Shared-Contracts/03-data-model-and-retention.md` |

## Source → module coverage

| Source | Sections | Modules |
|---|---|---|
| TrueCRM BRD | 24, 25, 26, 27 | Commerce, Marketing, HR, Sites |
| TrueCRM PRD | 24, 25, 26, 27 | Commerce, Marketing, HR, Sites |
| TrueCRM System Architecture | 24, 25, 26, 27 | Entities, module ownership and APIs of all four |
| Source cross-module sections | Users/Auth, Workspace Org, CRM, Catalog, Payments, Forms, Sales Intelligence, Analytics, Tasks, Calendar, Files, Workflows, Inventory, AI, Platform, Billing | Typed Shared-Contracts dependencies |
| Reference TrueAgent Auth ZIP | Agent.md, README, manifest, module Markdown, Testing | Structure/testing philosophy only |
| Bitrix24 Docs | e-commerce, marketing, worktime, site builder | Functional inspiration with TrueCRM deviations |

**Important design distinction:** confirmed Q72 prevents filling missing production dependencies with mock or cloned business services. See `Shared-Contracts/11-release-phases-and-dependencies.md`.
