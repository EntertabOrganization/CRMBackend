-- Document templates, immutable template revisions and generated business documents.
CREATE TABLE document_templates (
 id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
 name TEXT NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 200), description TEXT CHECK(description IS NULL OR length(description) <= 2000),
 document_type TEXT NOT NULL CHECK(document_type ~ '^[A-Z][A-Z0-9_]{0,49}$'), entity_type TEXT NOT NULL CHECK(length(entity_type) BETWEEN 1 AND 50),
 template_type TEXT NOT NULL CHECK(template_type IN ('HTML','DOCX')),
 output_formats TEXT[] NOT NULL CHECK(cardinality(output_formats) BETWEEN 1 AND 2 AND output_formats <@ ARRAY['PDF','DOCX']::text[]),
 number_prefix TEXT CHECK(number_prefix IS NULL OR number_prefix ~ '^[A-Za-z0-9_./-]{1,20}$'),
 source_file_id UUID, html_template TEXT CHECK(html_template IS NULL OR length(html_template) <= 262144), schema_json JSONB NOT NULL CHECK(jsonb_typeof(schema_json) = 'object'),
 current_revision_id UUID NOT NULL, current_revision INTEGER NOT NULL CHECK(current_revision > 0),
 is_active BOOLEAN NOT NULL, is_deleted BOOLEAN NOT NULL, deleted_at TIMESTAMPTZ,
 created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, updated_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 version INTEGER NOT NULL CHECK(version > 0), created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
 UNIQUE(workspace_id, id),
 CHECK(template_type = 'HTML' AND html_template IS NOT NULL AND source_file_id IS NULL OR
   template_type = 'DOCX' AND source_file_id IS NOT NULL AND html_template IS NULL AND output_formats = ARRAY['DOCX']::text[]),
 CHECK(is_deleted = (deleted_at IS NOT NULL) AND (NOT is_deleted OR NOT is_active))
);
CREATE INDEX document_templates_entity ON document_templates(workspace_id, entity_type);

CREATE TABLE document_template_revisions (
 id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT, template_id UUID NOT NULL,
 revision INTEGER NOT NULL CHECK(revision > 0), template_type TEXT NOT NULL CHECK(template_type IN ('HTML','DOCX')), entity_type TEXT NOT NULL,
 html_template TEXT, source_file_id UUID, source_version_id UUID, source_object_key TEXT, source_checksum TEXT CHECK(source_checksum IS NULL OR source_checksum ~ '^[a-f0-9]{64}$'),
 source_size_bytes DOUBLE PRECISION CHECK(source_size_bytes IS NULL OR source_size_bytes BETWEEN 0 AND 10485760 AND source_size_bytes = floor(source_size_bytes)),
 schema_json JSONB NOT NULL CHECK(jsonb_typeof(schema_json) = 'object'), variables TEXT[] NOT NULL, content_hash TEXT NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
 created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, created_at TIMESTAMPTZ NOT NULL,
 UNIQUE(template_id, revision), UNIQUE(workspace_id, template_id, id),
 FOREIGN KEY(workspace_id, template_id) REFERENCES document_templates(workspace_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 CHECK(template_type = 'HTML' AND html_template IS NOT NULL AND source_file_id IS NULL AND source_version_id IS NULL AND source_object_key IS NULL AND source_checksum IS NULL AND source_size_bytes IS NULL OR
   template_type = 'DOCX' AND html_template IS NULL AND source_file_id IS NOT NULL AND source_version_id IS NOT NULL AND source_checksum IS NOT NULL AND source_size_bytes IS NOT NULL
   AND source_object_key LIKE workspace_id::text || '/objects/document-templates/' || template_id::text || '/%')
);
ALTER TABLE document_templates ADD FOREIGN KEY(workspace_id, id, current_revision_id) REFERENCES document_template_revisions(workspace_id, template_id, id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE generated_documents (
 id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
 document_type TEXT NOT NULL CHECK(document_type ~ '^[A-Z][A-Z0-9_]{0,49}$'), entity_type TEXT NOT NULL, entity_id UUID NOT NULL,
 template_id UUID NOT NULL, template_revision_id UUID NOT NULL, output_format TEXT NOT NULL CHECK(output_format IN ('PDF','DOCX')),
 target_folder_id UUID NOT NULL, file_name TEXT CHECK(file_name IS NULL OR length(btrim(file_name)) BETWEEN 1 AND 200),
 file_id UUID, file_version_id UUID, document_number TEXT CHECK(document_number IS NULL OR length(document_number) BETWEEN 1 AND 40),
 status TEXT NOT NULL CHECK(status IN ('QUEUED','GENERATING','READY','FAILED','ARCHIVED')),
 generation_key TEXT NOT NULL CHECK(length(generation_key) BETWEEN 1 AND 200), request_hash TEXT NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 inputs JSONB NOT NULL CHECK(jsonb_typeof(inputs) = 'object'), context_hash TEXT CHECK(context_hash IS NULL OR context_hash ~ '^[a-f0-9]{64}$'),
 error_code TEXT CHECK(error_code IS NULL OR length(error_code) <= 100), regenerated_from_id UUID, superseded_by_id UUID,
 attempts INTEGER NOT NULL CHECK(attempts >= 0), claim_id UUID, lease_expires_at TIMESTAMPTZ, next_attempt_at TIMESTAMPTZ,
 generated_at TIMESTAMPTZ, archived_at TIMESTAMPTZ, created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 version INTEGER NOT NULL CHECK(version > 0), created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
 UNIQUE(workspace_id, generation_key), UNIQUE(workspace_id, id),
 FOREIGN KEY(workspace_id, template_id, template_revision_id) REFERENCES document_template_revisions(workspace_id, template_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(workspace_id, file_id, file_version_id) REFERENCES drive_file_versions(workspace_id, file_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(workspace_id, regenerated_from_id) REFERENCES generated_documents(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(workspace_id, superseded_by_id) REFERENCES generated_documents(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
 CHECK((claim_id IS NULL) = (lease_expires_at IS NULL)),
 CHECK((file_id IS NULL) = (file_version_id IS NULL)),
 CHECK(status <> 'READY' OR file_id IS NOT NULL AND generated_at IS NOT NULL AND context_hash IS NOT NULL),
 CHECK(status <> 'GENERATING' OR claim_id IS NOT NULL),
 CHECK((status = 'ARCHIVED') = (archived_at IS NOT NULL)),
 CHECK(superseded_by_id IS NULL OR superseded_by_id <> id)
);
CREATE INDEX generated_documents_source ON generated_documents(workspace_id, entity_type, entity_id);
CREATE INDEX generated_documents_due ON generated_documents(next_attempt_at) WHERE status IN ('QUEUED','GENERATING');

-- Identity and history guards: definitions keep their type/source, revisions never change, documents follow a one-way lifecycle.
CREATE FUNCTION document_template_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'DOCUMENT_TEMPLATE_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM workspace_memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=NEW.workspace_id AND m.user_id=NEW.updated_by_user_id AND NOT u.is_deleted)
 THEN RAISE EXCEPTION 'DOCUMENT_TEMPLATE_INVALID' USING ERRCODE='23514'; END IF;
 IF TG_OP = 'UPDATE' AND (NEW.workspace_id <> OLD.workspace_id OR NEW.template_type <> OLD.template_type OR NEW.entity_type <> OLD.entity_type OR
   NEW.created_by_user_id <> OLD.created_by_user_id OR NEW.created_at <> OLD.created_at OR NEW.current_revision < OLD.current_revision OR
   NEW.version < OLD.version OR OLD.is_deleted AND NOT NEW.is_deleted) THEN
  RAISE EXCEPTION 'DOCUMENT_TEMPLATE_IMMUTABLE' USING ERRCODE='23514';
 END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER document_template_guard BEFORE INSERT OR UPDATE OR DELETE ON document_templates FOR EACH ROW EXECUTE FUNCTION document_template_guard();

CREATE FUNCTION document_template_current_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current document_template_revisions%ROWTYPE;
BEGIN
 SELECT * INTO current FROM document_template_revisions WHERE id = NEW.current_revision_id AND template_id = NEW.id AND workspace_id = NEW.workspace_id;
 IF NOT FOUND OR current.revision <> NEW.current_revision OR current.template_type <> NEW.template_type OR current.entity_type <> NEW.entity_type OR
   current.html_template IS DISTINCT FROM NEW.html_template OR current.source_file_id IS DISTINCT FROM NEW.source_file_id OR current.schema_json <> NEW.schema_json OR
   EXISTS(SELECT 1 FROM document_template_revisions r WHERE r.template_id = NEW.id AND r.revision > current.revision) THEN
  RAISE EXCEPTION 'DOCUMENT_TEMPLATE_INVALID' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER document_template_current_guard AFTER INSERT OR UPDATE ON document_templates DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION document_template_current_guard();

CREATE FUNCTION document_template_revision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' OR TG_OP = 'UPDATE' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'DOCUMENT_TEMPLATE_REVISION_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF TG_OP = 'INSERT' AND NOT EXISTS(SELECT 1 FROM document_template_revisions WHERE id = NEW.id) AND (
   NOT EXISTS(SELECT 1 FROM workspace_memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=NEW.workspace_id AND m.user_id=NEW.created_by_user_id AND m.status='ACTIVE' AND NOT u.is_deleted)
   OR NEW.template_type = 'DOCX' AND NOT EXISTS(SELECT 1 FROM drive_file_versions v WHERE v.id = NEW.source_version_id AND v.file_id = NEW.source_file_id
     AND v.workspace_id = NEW.workspace_id AND v.checksum = NEW.source_checksum AND v.size_bytes = NEW.source_size_bytes AND v.scan_status = 'CLEAN' AND v.processed_at IS NOT NULL))
 THEN RAISE EXCEPTION 'DOCUMENT_TEMPLATE_INVALID' USING ERRCODE='23514'; END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER document_template_revision_guard BEFORE INSERT OR UPDATE OR DELETE ON document_template_revisions FOR EACH ROW EXECUTE FUNCTION document_template_revision_guard();

CREATE FUNCTION generated_document_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'GENERATED_DOCUMENT_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF TG_OP = 'INSERT' AND NOT EXISTS(SELECT 1 FROM generated_documents WHERE id = NEW.id) THEN
  IF NEW.status <> 'QUEUED' OR NEW.file_id IS NOT NULL OR NEW.attempts <> 0 OR NEW.superseded_by_id IS NOT NULL OR
    NOT EXISTS(SELECT 1 FROM workspace_memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=NEW.workspace_id AND m.user_id=NEW.created_by_user_id AND m.status='ACTIVE' AND NOT u.is_deleted)
    OR NOT EXISTS(SELECT 1 FROM document_template_revisions r JOIN document_templates t ON t.id = r.template_id AND t.workspace_id = r.workspace_id
      WHERE r.id = NEW.template_revision_id AND r.template_id = NEW.template_id AND r.workspace_id = NEW.workspace_id AND r.entity_type = NEW.entity_type
      AND t.is_active AND NOT t.is_deleted AND (r.template_type = 'HTML' OR NEW.output_format = 'DOCX'))
    OR NEW.regenerated_from_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM generated_documents g WHERE g.id = NEW.regenerated_from_id AND g.workspace_id = NEW.workspace_id
      AND g.entity_type = NEW.entity_type AND g.entity_id = NEW.entity_id AND g.template_id = NEW.template_id AND g.output_format = NEW.output_format)
  THEN RAISE EXCEPTION 'DOCUMENT_GENERATION_FAILED' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP = 'UPDATE' THEN
  IF NEW.workspace_id <> OLD.workspace_id OR NEW.document_type <> OLD.document_type OR NEW.entity_type <> OLD.entity_type OR NEW.entity_id <> OLD.entity_id OR
    NEW.template_id <> OLD.template_id OR NEW.template_revision_id <> OLD.template_revision_id OR NEW.output_format <> OLD.output_format OR
    NEW.target_folder_id <> OLD.target_folder_id OR NEW.file_name IS DISTINCT FROM OLD.file_name OR NEW.generation_key <> OLD.generation_key OR
    NEW.request_hash <> OLD.request_hash OR NEW.inputs <> OLD.inputs OR NEW.regenerated_from_id IS DISTINCT FROM OLD.regenerated_from_id OR
    NEW.created_by_user_id <> OLD.created_by_user_id OR NEW.created_at <> OLD.created_at OR NEW.version < OLD.version OR NEW.attempts < OLD.attempts OR
    OLD.file_id IS NOT NULL AND (NEW.file_id IS DISTINCT FROM OLD.file_id OR NEW.file_version_id IS DISTINCT FROM OLD.file_version_id OR
      NEW.context_hash IS DISTINCT FROM OLD.context_hash OR NEW.generated_at IS DISTINCT FROM OLD.generated_at) OR
    OLD.document_number IS NOT NULL AND NEW.document_number IS DISTINCT FROM OLD.document_number OR
    OLD.superseded_by_id IS NOT NULL AND NEW.superseded_by_id IS DISTINCT FROM OLD.superseded_by_id OR
    OLD.status = 'ARCHIVED' AND NEW IS DISTINCT FROM OLD OR
    OLD.status = 'READY' AND NEW.status NOT IN ('READY','ARCHIVED') OR
    OLD.status = 'FAILED' AND NEW.status NOT IN ('FAILED','ARCHIVED') OR
    NEW.status = 'READY' AND OLD.status NOT IN ('GENERATING','READY') OR
    NEW.superseded_by_id IS NOT NULL AND OLD.superseded_by_id IS NULL AND OLD.status <> 'READY'
  THEN RAISE EXCEPTION 'GENERATED_DOCUMENT_IMMUTABLE' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER generated_document_guard BEFORE INSERT OR UPDATE OR DELETE ON generated_documents FOR EACH ROW EXECUTE FUNCTION generated_document_guard();

-- Publication proof (checked when a document becomes READY or superseded): a READY document owns a clean, processed Version attached to its source record, and a business number
-- is held by at most one current (non-superseded) ready document per type.
CREATE FUNCTION generated_document_publication_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status = 'READY' AND (TG_OP = 'INSERT' OR OLD.status <> 'READY') AND (NOT EXISTS(SELECT 1 FROM drive_file_versions v JOIN drive_files f ON f.id = v.file_id AND f.workspace_id = v.workspace_id
     WHERE v.id = NEW.file_version_id AND v.file_id = NEW.file_id AND v.workspace_id = NEW.workspace_id AND v.scan_status = 'CLEAN' AND v.processed_at IS NOT NULL
     AND v.created_by_user_id = NEW.created_by_user_id AND v.object_key LIKE NEW.workspace_id::text || '/objects/generated-documents/' || NEW.id::text || '/%')
   OR NOT EXISTS(SELECT 1 FROM file_attachments a WHERE a.workspace_id = NEW.workspace_id AND a.file_id = NEW.file_id AND a.entity_type = NEW.entity_type
     AND a.entity_id = NEW.entity_id AND a.role = 'DOCUMENT'))
 THEN RAISE EXCEPTION 'DOCUMENT_GENERATION_FAILED' USING ERRCODE='23514'; END IF;
 IF NEW.superseded_by_id IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.superseded_by_id IS NULL) AND NOT EXISTS(SELECT 1 FROM generated_documents g WHERE g.id = NEW.superseded_by_id AND g.workspace_id = NEW.workspace_id
   AND g.regenerated_from_id = NEW.id AND g.status IN ('READY','ARCHIVED') AND g.file_id IS NOT NULL) THEN
  RAISE EXCEPTION 'GENERATED_DOCUMENT_IMMUTABLE' USING ERRCODE='23514';
 END IF;
 IF NEW.document_number IS NOT NULL AND (SELECT count(*) FROM generated_documents g WHERE g.workspace_id = NEW.workspace_id AND g.document_type = NEW.document_type
   AND g.document_number = NEW.document_number AND g.status = 'READY' AND g.superseded_by_id IS NULL) > 1 THEN
  RAISE EXCEPTION 'DOCUMENT_GENERATION_DUPLICATE' USING ERRCODE='23505';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER generated_document_publication_guard AFTER INSERT OR UPDATE ON generated_documents DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION generated_document_publication_guard();

-- Generation commits share the Files Workspace revision fence (quota, folders, attachments and authority sources).
CREATE TRIGGER document_template_revision BEFORE INSERT OR UPDATE OR DELETE ON document_templates FOR EACH ROW EXECUTE FUNCTION calendar_booking_source_epoch();
CREATE TRIGGER document_template_revision_revision BEFORE INSERT OR UPDATE OR DELETE ON document_template_revisions FOR EACH ROW EXECUTE FUNCTION calendar_booking_source_epoch();
CREATE TRIGGER generated_document_revision BEFORE INSERT OR UPDATE OR DELETE ON generated_documents FOR EACH ROW EXECUTE FUNCTION calendar_booking_source_epoch();
