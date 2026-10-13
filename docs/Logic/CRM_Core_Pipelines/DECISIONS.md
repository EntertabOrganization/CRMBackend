# Finalized Design Decisions — CRM Core + Pipelines

This file is a review index of the locked interview outcomes encoded throughout the pack. `Agent.md` and the module specs remain the execution contract.

- Core entities: Lead, Contact, CRM Company, Deal; no separate Customer table.
- Contact ↔ Company is many-to-many.
- Deal may have one Company plus multiple Contacts; at least one customer identity is required.
- One responsible user per core CRM record.
- Leads and Deals both support multiple pipelines.
- One reusable pipeline engine discriminated by LEAD/DEAL.
- Default Lead pipeline: New / Qualified / Disqualified.
- Default Deal pipeline: New / Won / Lost.
- Stage semantics: PROGRESS / SUCCESS / FAILURE.
- Lead success does not auto-convert.
- Explicit Lead conversion supports CREATE/LINK_EXISTING/NONE.
- Communications: PHONE / EMAIL / WEB / IM.
- Source catalog plus Lead UTM/origin metadata.
- Duplicate detection warns with 409 and requires explicit forceCreate to continue.
- Stage transitions use dedicated commands and optional transition graphs.
- FAILURE requires separate lost reason.
- Stage-required fields validate on entry through Module 05 boundary.
- Stage/pipeline deletion with live records uses explicit migration, never history rewrite.
- Permission model includes separate assign/convert/transition actions and stage view/enter/leave.
- OWN = current responsibleUserId only.
- Observers grant read-only access source.
- Deal-linked customer data may be shown only as a limited summary when independent customer permission is absent.
- Public API is entity-specific under /api/v1.
- Lists use cursor pagination.
- Sensitive state cannot be changed through ordinary PATCH.
- Idempotency-Key is retained for at least 24 hours.
- Optimistic version conflicts return 409.
- Cross-Workspace probing returns not found.
- Archive and soft delete are distinct.
- Referenced customer deletion is protected.
- Config values are deactivated, not rewritten out of history.
- Production migrations use expand -> backfill -> validate -> enforce.
- Unknown legacy stage/status mappings must stop migration rather than silently map to New.
- Contract tests must be wired and pass before FINISHED.
