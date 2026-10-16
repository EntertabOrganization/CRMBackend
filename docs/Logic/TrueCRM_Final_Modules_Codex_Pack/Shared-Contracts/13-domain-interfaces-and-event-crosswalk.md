# Typed domain seams and event crosswalk

| Producer/owner | Required consumer action | Rule |
|---|---|---|
| Knowledge article publish/revoke | Search projector and AI index | Published+approved+current ACL only; stale vector never bypasses access |
| AI start request | Billing reserve quota/credits | Reserve before provider request; release unused; settle actual |
| AI approved tool call | CRM/Task/Sites/etc owning domain | Validate tool schema, per-resource auth and user-approved exact arguments |
| Billing verified payment | Subscription activation, credit grant, Partner commission | Stable provider event/transaction IDs, no duplicate transition or credit |
| Billing refund/chargeback | Commission reversal | Immutable negative adjustment, never rewrite original accrual |
| Partner commercial relationship | Billing discount quotation | Exactly one ACTIVE relation; rate resolved from Partner and snapshotted in Billing |
| Partner delegated access revoke | Workspace permission cache/realtime/search | Revoke promptly, no relation deletion needed |
| Platform event/outbox | Notifications, Search, AI, Workflow, webhooks | DB commit first; consumer dedupe+safe retry |
| Privacy request/legal hold | Knowledge/AI/Billing/Partner purge hooks | Each owner enforces lawful retain/anonymize/delete gate |

## Logical interfaces

`KnowledgeService.publishRevision(articleId,revisionId,actor,expectedVersion)`; `KnowledgeRetrieval.retrieve(principal,query,classification)`; `EntitlementService.check(workspaceId,capability)`; `UsageService.reserve/settle/release`; `PartnerDiscountService.resolveForQuote`; `PartnerRelationService.activeForWorkspace`; `PartnerDelegationService.authorizeForCustomerWorkspace`; `OutboxPublisher.publishCommitted`; `AuditService.appendInTransaction`; `ScopedToolExecutor.executeApproved`. Concrete method paths are discovered from repository, not invented duplicate service classes.

Every event contains current aggregate version and correlation. Cross-module messages only carry references and safe minimal context; consumer refetches live permissions before reading source content. Source module remains authoritative if event arrives stale/out of order.
