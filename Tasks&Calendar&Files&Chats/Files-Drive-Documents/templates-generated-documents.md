# Document Templates & Generated Documents Specification

## Goal / Scope

Implement reusable DOCX/HTML business document templates and generated DOCX/PDF artifacts connected to source business records.

## Ownership / Boundary

`DocumentTemplatesController` owns template definitions/versions. `GeneratedDocumentsController` owns generation jobs/records and uses Files for final binary artifacts.

## Entities / Fields / Enums

```text
document_templates:
 id, workspaceId, name, templateType DOCX|HTML,
 sourceFileId nullable, htmlTemplate nullable,
 schemaJson, isActive, version

generated_documents:
 id, workspaceId, documentType,
 entityType, entityId,
 templateId, fileId nullable,
 outputFormat DOCX|PDF,
 documentNumber nullable,
 status QUEUED|GENERATING|READY|FAILED|ARCHIVED,
 generationKey, generatedAt nullable,
 createdByUserId, version
```
Published/used template versions must remain reproducible; repository may use explicit template-version table if existing pattern supports it.

## API Endpoints

```text
POST   /api/v1/document-templates
GET    /api/v1/document-templates
GET    /api/v1/document-templates/:id
PUT    /api/v1/document-templates/:id
PATCH  /api/v1/document-templates/:id
DELETE /api/v1/document-templates/:id
POST   /api/v1/document-templates/:id/preview
POST   /api/v1/generated-documents
GET    /api/v1/generated-documents
GET    /api/v1/generated-documents/:id
GET    /api/v1/generated-documents/:id/download
POST   /api/v1/generated-documents/:id/regenerate
DELETE /api/v1/generated-documents/:id
```

## Business Rules / Validation

- Generation input context is permission-checked against source entity.
- Template variables are schema-validated; no arbitrary code execution.
- DOCX and HTML templates may output DOCX/PDF as applicable.
- Large generation runs as job and returns 202/operation state.
- Generation retry with same generationKey is idempotent.
- Generated output becomes a logical File/Version and attaches through File service.
- Regeneration creates new document/File version/history rather than mutating old legal artifact silently.

## Permissions

- `DOCUMENT_TEMPLATE.CREATE`
- `DOCUMENT_TEMPLATE.READ`
- `DOCUMENT_TEMPLATE.UPDATE`
- `DOCUMENT_TEMPLATE.DELETE`
- `DOCUMENT.GENERATE`
- `DOCUMENT.READ`
- `DOCUMENT.DELETE`

## Tenant / Ownership Rules

- All business rows and queries are scoped to the resolved active Workspace.
- Cross-Workspace IDs must not be linkable or inferable through this API.
- Resource-level authorization is re-evaluated server-side on every operation; possession of an ID is never authorization.

## Stable Error Cases

- `DOCUMENT_TEMPLATE_NOT_FOUND`
- `DOCUMENT_TEMPLATE_INVALID`
- `DOCUMENT_CONTEXT_ACCESS_DENIED`
- `DOCUMENT_GENERATION_FAILED`
- `DOCUMENT_GENERATION_DUPLICATE`
- `PERMISSION_DENIED`

## Domain / Outbox Events

- `DOCUMENT_TEMPLATE_CHANGED`
- `DOCUMENT_GENERATION_QUEUED`
- `DOCUMENT_GENERATED`
- `DOCUMENT_GENERATION_FAILED`

## Audit Events / Evidence

- `Generated business document creation/destruction and template security-sensitive changes are audited.`

## Dependencies / Integrations

- Files
- Jobs
- Business entity adapters
- Numbering service

## Testing Requirements

- Template injection/invalid variables.
- Job retry.
- Source entity becomes unauthorized.
- Regenerate preserving old output.

## Acceptance Criteria

- Generated artifacts are reproducible/history-safe.
- Document generation cannot read unauthorized business fields.
