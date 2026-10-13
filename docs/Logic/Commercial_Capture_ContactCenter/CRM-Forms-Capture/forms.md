# CRM Forms Core Specification

> **Backend-only implementation scope:** This specification authorizes server-side work only: database schema and migrations, domain/application services, REST APIs, authorization, audit/outbox events, workers/jobs, provider adapters, and automated backend tests. Do not create, modify, scaffold, or test frontend pages, UI components, browser views, styling, or client-side application code. Any UI/browser wording below defines backend-facing behavior or security constraints only.


## Goal / Boundary

Provide Workspace-scoped public/internal forms that durably collect data and optionally process it into CRM records. A Form may be `SUBMISSION_ONLY` or use a CRM capture recipe.

Form is the logical configured resource. Form Version is the publishable immutable schema. Submission is a separate durable record.

## Form entity

`crm_forms` logical fields:

```text
id UUID
workspaceId UUID
name string
publicKey UUID/random token unique
mode SUBMISSION_ONLY | CRM_CAPTURE
accessMode PUBLIC | AUTHENTICATED | RESTRICTED_TOKEN
status DRAFT | PUBLISHED | UNPUBLISHED | ARCHIVED
currentDraftVersionId nullable UUID
publishedVersionId nullable UUID
successAction MESSAGE | REDIRECT
successMessage nullable string
redirectUrl nullable string
spamPolicyId/config nullable
assignmentPolicyId nullable
captureRecipeId nullable
responsibleUserId nullable UUID
```

Internal IDs are not trusted public locators. Public route resolves by `publicKey` or a server-resolved custom slug mapping.

## Public access

Suggested public routes:

```text
GET  /api/v1/public/forms/:publicKey
POST /api/v1/public/forms/:publicKey/submissions
```

Authenticated/internal administration:

```text
POST  /api/v1/forms
GET   /api/v1/forms
GET   /api/v1/forms/:id
PATCH /api/v1/forms/:id
POST  /api/v1/forms/:id/publish
POST  /api/v1/forms/:id/unpublish
POST  /api/v1/forms/:id/archive
GET   /api/v1/forms/:id/submissions
```

Do not expose privileged Workspace, pipeline, owner or arbitrary CRM IDs as trusted public request fields. They come from published server-side configuration.

## Access modes

### PUBLIC

No TrueCRM account required.

### AUTHENTICATED

Require authenticated user and appropriate form eligibility. Authentication does not imply form-administration rights.

### RESTRICTED_TOKEN

Require a signed/random expiring access token with form-specific scope. Store only a secure hash where token persistence is needed. The token is not a generic Workspace session.

## Submission-only mode

A valid Submission is stored and may trigger Notifications/Automation but does not require CRM entity creation.

## CRM-capture mode

After durable Submission, asynchronous processing executes the configured capture recipe from `crm-capture-and-duplicate-resolution.md`.

## Public endpoint protection

- rate limit by Form and abuse context/IP according to platform policy;
- CAPTCHA/spam adapter when configured;
- validate exact published schema;
- body/file count/size limits;
- safe file flow through Files/quarantine;
- success redirect validated when admin configures/publishes, never from submitter input;
- idempotency/replay protection;
- abuse/security logging without unnecessary sensitive data.

## Permissions

```text
form.create
form.read
form.update
form.publish
form.unpublish
form.archive
form.read_submission
form.export_submission
form.manage_security
form.manage_capture
```

Submission visibility follows Form/module scope and any field/sensitive-data restrictions.

## Events

```text
FORM_CREATED
FORM_UPDATED
FORM_PUBLISHED
FORM_UNPUBLISHED
FORM_ARCHIVED
FORM_SUBMITTED
FORM_PROCESSING_SUCCEEDED
FORM_PROCESSING_PARTIALLY_FAILED
FORM_PROCESSING_FAILED
FORM_ENTITY_BOUND
```

## Acceptance criteria

- anonymous submitter can use a PUBLIC form without signup;
- public payload cannot switch Workspace or inject privileged target IDs;
- SUBMISSION_ONLY succeeds without CRM creation;
- CRM_CAPTURE stores Submission before processing;
- unauthorized admin/submission reads fail;
- unpublishing blocks new public submissions without deleting history;
- every final Submission points to the exact published version received by submitter.
