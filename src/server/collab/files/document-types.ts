import type { ActorContext } from '../../access-service';
import type { TemplateValue } from './document-render';

export const TEMPLATE_TYPES = ['HTML', 'DOCX'] as const;
export const OUTPUT_FORMATS = ['PDF', 'DOCX'] as const;
export const INPUT_TYPES = ['string', 'number', 'boolean', 'date'] as const;
export const GENERATED_STATUSES = ['QUEUED', 'GENERATING', 'READY', 'FAILED', 'ARCHIVED'] as const;

export type TemplateInput = { type: typeof INPUT_TYPES[number]; required: boolean; label?: string; maxLength?: number; enum?: string[] };
/** `inputs` are caller-supplied values; entity fields come only from the registered source adapter. */
export type TemplateSchema = { inputs: Record<string, TemplateInput> };

export type DocumentTemplate = {
  id: string; workspaceId: string; name: string; description: string | null; documentType: string; entityType: string;
  templateType: typeof TEMPLATE_TYPES[number]; outputFormats: Array<typeof OUTPUT_FORMATS[number]>; numberPrefix: string | null;
  sourceFileId: string | null; htmlTemplate: string | null; schemaJson: TemplateSchema;
  currentRevisionId: string; currentRevision: number; isActive: boolean; isDeleted: boolean; deletedAt: Date | null;
  createdByUserId: string; updatedByUserId: string; version: number; createdAt: Date; updatedAt: Date;
};

/** Immutable content snapshot; every generated document pins one, so published output stays reproducible. */
export type DocumentTemplateRevision = {
  id: string; workspaceId: string; templateId: string; revision: number; templateType: DocumentTemplate['templateType'];
  entityType: string; htmlTemplate: string | null; sourceFileId: string | null; sourceVersionId: string | null;
  sourceObjectKey: string | null; sourceChecksum: string | null; sourceSizeBytes: number | null;
  schemaJson: TemplateSchema; variables: string[]; contentHash: string; createdByUserId: string; createdAt: Date;
};

export type GeneratedDocument = {
  id: string; workspaceId: string; documentType: string; entityType: string; entityId: string;
  templateId: string; templateRevisionId: string; outputFormat: typeof OUTPUT_FORMATS[number];
  targetFolderId: string; fileName: string | null; fileId: string | null; fileVersionId: string | null; documentNumber: string | null;
  status: typeof GENERATED_STATUSES[number]; generationKey: string; requestHash: string; inputs: Record<string, TemplateValue>;
  contextHash: string | null; errorCode: string | null; regeneratedFromId: string | null; supersededById: string | null;
  attempts: number; claimId: string | null; leaseExpiresAt: Date | null; nextAttemptAt: Date | null;
  generatedAt: Date | null; archivedAt: Date | null; createdByUserId: string; version: number; createdAt: Date; updatedAt: Date;
};

/**
 * Source records expose a read projection through their owning module. `read` must throw when the actor cannot read the
 * record and must omit any field the actor may not see; a template referencing an omitted field fails closed.
 */
export interface DocumentContextAdapter {
  entityType: string;
  fields: readonly string[];
  supportsCustomFields?: boolean;
  read(actor: ActorContext, entityId: string): { fields: Record<string, TemplateValue>; customFields?: Record<string, TemplateValue> };
}
