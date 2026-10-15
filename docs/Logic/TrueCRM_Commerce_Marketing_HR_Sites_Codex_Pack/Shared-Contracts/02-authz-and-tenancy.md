# Authorization, ownership and tenant isolation

## Resolution sequence

1. Resolve trusted caller identity (employee session, scoped integration principal, public/customer token, verified provider webhook).
2. Resolve workspace from active membership or verified public host/connection. Reject spoofed workspace IDs; object IDs from other workspaces must not leak their existence.
3. Check feature rollout flag ∩ effective Subscription entitlement ∩ role/action ∩ scope ∩ resource state ∩ field/stage policy. Owner/admin capabilities do not bypass subscribed features or legal holds automatically.
4. Validate every related object belongs to same workspace, including stores, Orders, products, warehouses, employee profiles, sites, forms, campaigns, merchant accounts and files.
5. Write audit including explicit actor, principal type, scope decision and correlation. Read failures log sanitized security events where warranted.

## Permission namespaces and minimum action set

- Commerce: `commerce.store.{read,create,edit,activate,suspend}`, `commerce.catalog.{publish,price.manage}`, `commerce.order.{read,amend,transition,cancel}`, `commerce.payment.{read,reconcile,refund}`, `commerce.shipment.{create,dispatch}`, `commerce.return.{create,review,receive}`, `commerce.promotion.manage`, `commerce.tax.manage`, `commerce.analytics.{read,export}`.
- Marketing: `marketing.segment.{read,create,edit}`, `marketing.audience.{import,export}`, `marketing.consent.manage`, `marketing.provider.manage`, `marketing.sender.manage`, `marketing.template.{edit,approve,test}`, `marketing.campaign.{create,edit,approve,publish,pause,cancel}`, `marketing.delivery.retry`, `marketing.analytics.{read,export}`, `marketing.ads.manage`.
- HR: `hr.employee.{read_self,read_department,read_all,manage}`, `hr.employee.private.{read,write}`, `hr.schedule.manage`, `hr.shift.manage`, `hr.worktime.{clock_self,record_other}`, `hr.attendance.{request,approve_team,override_all,evidence.read}`, `hr.timesheet.{submit_self,approve_team,reopen_hr}`, `hr.overtime.{request_self,approve_team,policy.manage}`, `hr.leave.{request_self,approve_team,policy.manage,balance.override,reason.read}`, `hr.documents.{read_confidential,manage}`, `hr.lifecycle.manage`, `hr.analytics.{read,export}`.
- Sites: `sites.site.{read,create,edit,domain.manage,publish,delete,restore,export}`, `sites.page.{create,edit,delete}`, `sites.sharedblock.publish`, `sites.content.publish`, `sites.localization.{edit,approve,publish}`, `sites.seo.manage`, `sites.script.{manage,approve}`, `sites.experiment.manage`, `sites.ai.generate`.

## Scopes

`OWN`, `DEPARTMENT`, `DEPARTMENT_TREE`, `TEAM`, `ALL`; explicit `SELF`, `CUSTOMER_OWN_ORDER` and `PUBLIC_PUBLISHED_ONLY` are narrow subject/resource policies, not normal tenant roles. Resource-scoped assignment and stage/field rules can further narrow access. Deny wins over broad grants where explicitly configured.

## Non-negotiable examples

- Customer portal token can read only that customer's paid/placed orders; cannot view another customer or CRM contact by guessing UUID.
- Marketing import/edit does not imply exporting recipient PII; campaign publish does not imply provider credential manage.
- Manager schedule/attendance read is limited to authorized department hierarchy and cannot see restricted employee reason/document unless separately allowed.
- Site edit does not imply site publish; site publish does not imply unreviewed custom scripts.
- System/AI/workflow action must execute through an explicitly scoped service identity and normal owning domain API; never as a universal DB superuser.
