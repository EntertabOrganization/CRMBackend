# Lead Specification

## Goal

Implement Lead as a Workspace-scoped sales inquiry/prospect record with responsibility, normalized communications, source/acquisition context, pipeline/stage state, existing-customer links, duplicate protection and explicit conversion.

## Meaning

A Lead is an inquiry/prospect, not yet the authoritative customer record.

A Lead may represent:

- a net-new person/business
- an anonymous/new inquiry
- a returning customer inquiry already linked to existing Contact/CRM Company records

Lead success/qualification does not automatically convert it.

## Suggested persistent fields

Adapt names to repository convention while preserving behavior:

- id UUID
- workspaceId
- title / display title
- firstName/lastName or equivalent person-name fields where supported
- companyName/free-form captured organization name where useful before Company creation
- responsibleUserId
- pipelineId
- stageId
- sourceId nullable
- sourceDescription nullable
- estimatedAmount nullable
- currencyCode nullable
- ordinary address fields
- utmSource / utmMedium / utmCampaign / utmContent / utmTerm
- originSystem / originExternalId / originVersion
- conversionStatus, at least NOT_CONVERTED | CONVERTED
- convertedAt nullable
- convertedByUserId nullable
- closure fields required by semantic state
- lostReasonId nullable
- lostReasonComment nullable
- isArchived / archivedAt / archivedByUserId
- isDeleted / deletedAt / deletedByUserId
- createdAt
- updatedAt
- version

## Pipeline rules

Every active Lead belongs to exactly one LEAD pipeline and a stage in that pipeline.

Creation:

- if pipeline omitted, use Workspace default LEAD pipeline
- if stage omitted, use that pipeline's default PROGRESS stage
- if supplied, both must be same Workspace and type-compatible

Lead may move between LEAD pipelines using the dedicated transition command.

It may never enter a DEAL pipeline.

## Communications

Use normalized Lead communications. Support PHONE, EMAIL, WEB and IM.

Do not store only one phone/email as the entire model.

## Existing customer links

A Lead may link to existing Contacts and/or one existing CRM Company according to implemented relationship model.

Links do not convert the Lead by themselves.

## Duplicate behavior

On creation, check likely duplicates using normalized communication/customer identifiers.

If found and no explicit override:

```text
409 CRM_DUPLICATE_DETECTED
```

Never merge automatically.

## Permissions

Use at minimum:

```text
crm.lead.create
crm.lead.read
crm.lead.update
crm.lead.delete
crm.lead.assign
crm.lead.convert
crm.lead.transition
```

OWN means `responsibleUserId == currentUser.id`.

## Dedicated commands

Do not allow ordinary PATCH to directly change:

- responsibleUserId
- pipelineId
- stageId
- conversionStatus

Use assign/transition/convert commands.

## Converted Lead behavior

After conversion:

- Lead remains queryable for authorized history/reporting
- conversion outputs remain linked through conversion history
- second conversion is rejected with `CRM_ALREADY_CONVERTED`
- normal processing transitions are rejected
- mutation of conversion-critical source/customer qualification data is restricted

## Acceptance criteria

- Lead is always Workspace scoped
- default pipeline/stage assignment works
- multiple LEAD pipelines work
- semantic SUCCESS does not convert automatically
- existing customer links are allowed
- duplicate warning/force-create works
- responsible user defaults and reassignment rules work
- archive/delete lifecycle works
- cross-Workspace IDs are hidden as not found
- optimistic version conflicts reject stale writes
