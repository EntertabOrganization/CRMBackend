# Form Submissions and Processing Specification

> **Backend-only implementation scope:** This specification authorizes server-side work only: database schema and migrations, domain/application services, REST APIs, authorization, audit/outbox events, workers/jobs, provider adapters, and automated backend tests. Do not create, modify, scaffold, or test frontend pages, UI components, browser views, styling, or client-side application code. Any UI/browser wording below defines backend-facing behavior or security constraints only.


## Goal

Store final Submissions immutably before CRM processing; support optional resumable drafts, files, consent evidence, attribution, deterministic processing states and safe retry.

## Entities

### `crm_form_submissions`

```text
id UUID
workspaceId UUID
formId UUID
formVersionId UUID
publicSubmissionNumber nullable string
submissionState DRAFT | SUBMITTED
processingStatus NOT_REQUIRED | PENDING | PROCESSING | SUCCEEDED | PARTIALLY_FAILED | FAILED
idempotencyKeyHash/key metadata nullable
submittedAt nullable timestamptz
sourceIpHash/metadata only if privacy policy permits
userAgent metadata only if privacy policy permits
submitterUserId nullable UUID
resumeExpiresAt nullable timestamptz
```

### Values

`crm_form_submission_values` stores normalized typed values keyed to exact Form Version/Field.

### Files

`crm_form_files` stores references to shared File/upload records and scan/finalization state. Binary data is not duplicated.

### Attribution

`crm_form_attribution` stores configured UTM/referrer/visitor/session/source observations. Marketing attribution is distinct from operational creation source.

### Consent evidence

Store:
- submission ID;
- agreement/field ID;
- agreement version/reference;
- accepted value;
- acceptance timestamp;
- evidence/source metadata allowed by privacy policy.

Current agreement edits never rewrite old consent evidence.

## Final submit flow

1. resolve Form + published Version server-side;
2. verify access mode/token/session;
3. apply rate/spam/CAPTCHA controls;
4. validate fields and conditions server-side;
5. verify/finalize eligible uploaded file references;
6. begin database transaction;
7. create immutable SUBMITTED row + values + attribution + consent references;
8. create idempotency protection;
9. commit;
10. return accepted response;
11. CRM_CAPTURE -> enqueue processing and set PENDING;
12. SUBMISSION_ONLY -> set NOT_REQUIRED or trigger configured non-CRM events.

A downstream CRM/provider/automation outage after commit cannot cause accepted Submission loss.

## Idempotency

For the same Form/Version + idempotency key and semantically same request, return original result.

Same key with materially different payload -> `IDEMPOTENCY_KEY_REUSED`.

Do not globally dedupe all submissions by email/phone. Repeat legitimate inquiries are allowed; duplicate policy belongs to CRM capture.

## Resumable drafts

Optional per Form.

- create DRAFT with opaque resume token;
- token expires and is stored hashed where appropriate;
- draft updates are allowed until submitted/expired;
- final submit validates against draft's associated version;
- if Form is republished during draft, default behavior is finish against original version until draft expiry rather than silently switching schema;
- once SUBMITTED, it cannot be edited as a draft.

## File flow

1. upload to temporary/quarantine storage;
2. validate size/MIME/extension;
3. validate signed upload ownership/Form context;
4. scan;
5. only CLEAN/APPROVED file may become active attachment;
6. infected/failed scan remains blocked/quarantined;
7. file from another Form/Workspace cannot be bound.

## Processing states

```text
PENDING -> PROCESSING -> SUCCEEDED
                      -> PARTIALLY_FAILED
                      -> FAILED
```

Use job lease/locking so two workers cannot process same Submission concurrently.

`PARTIALLY_FAILED` persists exact step outcomes. Retry resumes idempotently from completed steps rather than recreating them.

## Admin API

```text
GET  /api/v1/forms/:formId/submissions
GET  /api/v1/forms/:formId/submissions/:submissionId
POST /api/v1/forms/:formId/submissions/:submissionId/retry-processing
```

Sensitive fields/files honor permissions.

## Errors

```text
FORM_NOT_PUBLISHED
FORM_ACCESS_DENIED
FORM_TOKEN_INVALID_OR_EXPIRED
FORM_VALIDATION_FAILED
FORM_SPAM_REJECTED
FORM_UPLOAD_INVALID
FORM_UPLOAD_NOT_CLEAN
FORM_SUBMISSION_CONFLICT
IDEMPOTENCY_KEY_REUSED
FORM_PROCESSING_NOT_RETRYABLE
```

## Acceptance criteria

- invalid input returns deterministic field-key errors;
- final Submission survives downstream processing failure;
- retry does not duplicate CRM outcomes;
- repeated same idempotency key creates one final Submission;
- foreign Form/Workspace file cannot bind;
- values/consent stay tied to exact Form Version;
- resume token expiry and one-way finalization are enforced.
