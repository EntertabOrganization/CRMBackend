-- Keep immutable object ownership independent of File metadata: copies reuse the
-- same object, and deleting the original File must never lift its restrictions.
CREATE TABLE file_artifact_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  object_key text NOT NULL,
  entity_type text NOT NULL CHECK (entity_type IN ('SPA_EXPORT_JOB', 'SPA_IMPORT_JOB')),
  entity_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT file_artifact_bindings_workspace_id_object_key_key UNIQUE (workspace_id, object_key),
  CONSTRAINT file_artifact_bindings_object_workspace CHECK (object_key LIKE workspace_id::text || '/objects/%')
);
CREATE INDEX file_artifact_bindings_workspace_id_entity_type_entity_id_idx
  ON file_artifact_bindings(workspace_id, entity_type, entity_id);

-- Backfill every retained version, including keys already reused by File copies.
INSERT INTO file_artifact_bindings (workspace_id, object_key, entity_type, entity_id)
SELECT DISTINCT j.workspace_id, v.object_key, 'SPA_EXPORT_JOB', j.id
FROM spa_export_jobs j JOIN drive_file_versions v
  ON v.workspace_id = j.workspace_id AND v.file_id = j.download_file_id;
INSERT INTO file_artifact_bindings (workspace_id, object_key, entity_type, entity_id)
SELECT DISTINCT j.workspace_id, v.object_key, 'SPA_IMPORT_JOB', j.id
FROM spa_import_jobs j JOIN drive_file_versions v
  ON v.workspace_id = j.workspace_id AND v.file_id = j.report_file_id;

CREATE FUNCTION file_artifact_binding_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'File artifact ownership is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER file_artifact_binding_immutable
  BEFORE UPDATE OR DELETE ON file_artifact_bindings
  FOR EACH ROW EXECUTE FUNCTION file_artifact_binding_immutable();

CREATE FUNCTION file_artifact_binding_owner_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM drive_file_versions
      WHERE workspace_id = NEW.workspace_id AND object_key = NEW.object_key)
    OR (NEW.entity_type = 'SPA_EXPORT_JOB' AND NOT EXISTS (
      SELECT 1 FROM spa_export_jobs WHERE workspace_id = NEW.workspace_id AND id = NEW.entity_id))
    OR (NEW.entity_type = 'SPA_IMPORT_JOB' AND NOT EXISTS (
      SELECT 1 FROM spa_import_jobs WHERE workspace_id = NEW.workspace_id AND id = NEW.entity_id)) THEN
    RAISE EXCEPTION 'File artifact owner is unavailable in this Workspace' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER file_artifact_binding_owner_guard
  BEFORE INSERT ON file_artifact_bindings
  FOR EACH ROW EXECUTE FUNCTION file_artifact_binding_owner_guard();
