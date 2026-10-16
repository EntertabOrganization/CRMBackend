# Identity, tenant isolation and permission matrix

User is globally unique identity. Workspace is an isolated tenant. Partner is a platform-level channel organization. PartnerMembership is not WorkspaceMembership. Platform Admin is global privileged policy role but not silent tenant-reader. AI Role describes model behavior, never grants database access.

## Authorization algorithm

1. Validate signed session/identity and MFA if high risk.
2. Resolve one active Workspace context **or** distinct Partner/Platform context. Never use untrusted body Workspace ID as authority.
3. Check active membership, role grants, resource action and OWN/DEPARTMENT/DEPARTMENT_TREE/TEAM/ALL scope. Apply resource status, stage/field ACL and module subscription entitlement/feature flag.
4. Knowledge/Files/CRM require their OWN domain authorization even when reference comes from AI index/search or a message link.
5. Partner customer Workspace access is special: active Partner member permission AND active PartnerWorkspaceAccess grant AND Workspace resource authorization, no automatic WorkspaceMembership. Revocation/expiry/suspension must fail closed.
6. Platform support: purpose-bound, narrow scope, customer approved when policy requires; audit emergency approval separately.

## Minimum permission catalog

| Area | Distinct actions |
|---|---|
| Knowledge | `knowledge.space.create/read/manage`, `knowledge.article.create/edit/readRevision/publish/move/delete/purge`, `knowledge.share`, `knowledge.import/export`, `knowledge.aiIndex.manage`, `knowledge.analytics.read` |
| AI | `ai.scenario.execute`, `ai.scenario.manage`, `ai.provider.manage`, `ai.route.manage`, `ai.tool.approve`, `ai.tool.grant`, `ai.external.connect`, `ai.budget.manage` |
| Platform | `platform.events.inspect/replay`, `platform.jobs.inspect/retry`, `platform.audit.read`, `platform.support.request`, `workspace.support.approve`, `platform.featureflag.manage`, `platform.privacy.manage` |
| Billing | `billing.plan.manage`, `billing.subscription.read/change/cancel`, `billing.credits.purchase/read`, `billing.refund.approve`, `billing.overage.manage`, `billing.reconciliation.run` |
| Partner | `partner.application.submit`, `platform.partner.application.approve`, `partner.members.manage`, `partner.workspace.provision`, `partner.discount.readOwn`, `platform.partner.discount.manage`, `partner.finance.readOwn`, `partner.payout.request`, `platform.partner.payout.approve`, `workspace.partnerAccess.approve/revoke` |

Role defaults should be seeded as policy, then computed from actual grants. Never hard-code `user.role === 'admin'` across all contexts. Privilege changes invalidate auth cache/realtime; audit old/new grant redacted. Keep protected Platform Admin separate from Partner Owner and Workspace Owner.
