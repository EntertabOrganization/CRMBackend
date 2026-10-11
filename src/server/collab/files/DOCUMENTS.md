# Document templates and generated documents

## Templates

`POST/GET/PUT/PATCH/DELETE /api/v1/document-templates[/:id]` and `POST /api/v1/document-templates/:id/preview` manage reusable HTML or DOCX templates. Permissions: `document_template.create|read|update|delete`. Each template is bound to one source `entityType` (TASK, PROJECT, LEAD, DEAL, CONTACT, COMPANY and any other registered field adapter) and a `documentType` (upper-case identifier). `templateType` and `entityType` are fixed after creation. Updates require `version` (or `If-Match`).

Content changes (`htmlTemplate`, `sourceFileId`, `schemaJson`) create a new immutable `document_template_revisions` row; metadata-only changes do not. A DOCX source File must be readable by the editor and have clean, processed content; its bytes are copied into a template-owned immutable object (`<workspace>/objects/document-templates/...`), so later File edits, Versions or purges never change a published revision. Deleting a template is a soft delete: revisions and generated history remain.

### Template language

Only `{{path}}` and `{{#if path}}…{{else}}…{{/if}}` (HTML only) are recognised; any other tag, `{{{`, or unbalanced braces are rejected with `DOCUMENT_TEMPLATE_INVALID`. Paths:

- `entity.<field>` — a field declared by the source adapter; `entity.customFields.<code>` for CRM custom fields.
- `input.<key>` — declared in `schemaJson.inputs` (`string|number|boolean|date`, `required`, `maxLength`, `enum`).
- `document.number|date|title|type`, `workspace.name`.

Values are escaped and never re-parsed; a value containing markup or template syntax renders literally. HTML templates containing scripts, embedded objects, event handlers or script URLs are refused. DOCX placeholders must sit in one formatting run; a placeholder split by Word formatting is rejected rather than left in output.

## Generation

`POST /api/v1/generated-documents` (`document.generate`) accepts `templateId`, `entityId`, `folderId`, `generationKey`, optional `outputFormat`, `inputs` and `fileName`, validates the source record (through the owning module's adapter, including field visibility), inputs and target folder (`file.create`, ADD access), and returns **202** with a QUEUED document. Repeating a `generationKey` with the same request returns the same document; a different request returns `DOCUMENT_GENERATION_DUPLICATE`.

The `document-generation` scheduler job (`POST /api/v1/internal/crm/jobs/document-generation`, `{ "limit": 1-100 }`, internal job token) claims due documents under a 5-minute lease, rebuilds the creator's live authority (active membership, `document.generate`, template still active, source record and every referenced field readable, target folder writable), renders deterministic PDF (A4, Helvetica, WinAnsi; unsupported characters render as `?`) or DOCX output, scans it with the configured content processor, writes an attempt-scoped immutable object and, after re-proving authority and that the referenced source data is unchanged, commits one File, one clean Version and a `DOCUMENT` attachment to the source record in a single transaction. Run it regularly alongside `upload-processing` and `file-object-garbage`.

Processor outages, storage errors and source changes during rendering retry with capped exponential backoff (5 attempts); lost authority, inactive templates, blocked content and quota failures end as `FAILED` with a stable `errorCode`. Unpublished output objects are queued for the object garbage worker.

Templates with a `numberPrefix` allocate `<prefix><6-digit sequence>` per Workspace and document type when work first starts; a number consumed by a terminally failed generation is not reused.

## Reads, download, regeneration, archive

`GET /api/v1/generated-documents[/:id]` (`document.read`) only returns documents whose source record the caller can read (`DOCUMENT_CONTEXT_ACCESS_DENIED` otherwise). Lists hide ARCHIVED rows unless `status=ARCHIVED` or `includeArchived=true`. `GET /:id/download` issues the standard single-use File delivery path for the generated Version (`file.download` and File/attachment authority apply); if a later Version was uploaded to that File, download returns `DOCUMENT_ARTIFACT_CHANGED` and the artifact remains in File Version history.

`POST /:id/regenerate` (`generationKey`, optional `inputs`, `useCurrentTemplate` default true) creates a new document and a new File; the previous document keeps its File/Version and gains `supersededById`. Only the latest READY or FAILED document can be regenerated. `useCurrentTemplate: false` pins the original revision and reproduces identical bytes for unchanged source data. Regenerations keep the original document number.

`DELETE /:id` (`document.delete`, `version`) archives the record and stops pending work. The generated File is retained as the legal artifact and follows normal File retention/trash rules.

## Database guards

Migration `20261011210000_document_templates_generation` enforces tenant-composite keys, template type/content/format consistency, immutable revisions (no update/delete), DOCX revision provenance against a clean source Version, the document lifecycle (QUEUED/GENERATING → READY/FAILED → ARCHIVED, no deletes, immutable identity and publication fields), publication proof (clean processed Version under the document's object namespace, created by the requester and attached to the source record), single current holder of a document number, and the shared Files Workspace revision fence.

Rendering has been exercised with deterministic fixtures; deployments must configure the content processor, shared object storage and scheduler as for uploads.
