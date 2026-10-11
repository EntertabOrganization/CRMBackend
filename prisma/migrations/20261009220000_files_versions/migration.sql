CREATE TABLE drive_files (
  id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  storage_id UUID NOT NULL, folder_id UUID NOT NULL, name TEXT NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 500),
  extension TEXT NOT NULL, mime_type TEXT NOT NULL, current_version_id UUID,
  status TEXT NOT NULL CHECK(status IN ('PROCESSING','ACTIVE','QUARANTINED','BLOCKED','TRASHED')),
  size_bytes_current DOUBLE PRECISION NOT NULL CHECK(size_bytes_current >= 0 AND size_bytes_current < 9007199254740992 AND size_bytes_current = floor(size_bytes_current)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0), trashed_at TIMESTAMPTZ, purge_after TIMESTAMPTZ,
  original_folder_id UUID, status_before_trash TEXT CHECK(status_before_trash IN ('PROCESSING','ACTIVE','QUARANTINED','BLOCKED')),
  public_share_version INTEGER NOT NULL DEFAULT 1 CHECK(public_share_version > 0), created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE(workspace_id, id), FOREIGN KEY(workspace_id, storage_id, folder_id) REFERENCES file_folders(workspace_id, storage_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX drive_file_folder ON drive_files(workspace_id, storage_id, folder_id);
CREATE UNIQUE INDEX drive_file_sibling_name ON drive_files(workspace_id, storage_id, folder_id, lower(btrim(normalize(name, NFC)) COLLATE "und-x-icu")) WHERE status <> 'TRASHED';
CREATE TABLE drive_file_versions (
  id UUID PRIMARY KEY, workspace_id UUID NOT NULL, file_id UUID NOT NULL, version_number INTEGER NOT NULL CHECK(version_number > 0),
  object_key TEXT NOT NULL CHECK(length(object_key) BETWEEN 1 AND 1000),
  size_bytes DOUBLE PRECISION NOT NULL CHECK(size_bytes >= 0 AND size_bytes < 9007199254740992 AND size_bytes = floor(size_bytes)),
  checksum TEXT NOT NULL CHECK(checksum ~ '^[a-f0-9]{64}$'), mime_type TEXT NOT NULL, created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL, scan_status TEXT NOT NULL CHECK(scan_status IN ('PENDING','CLEAN','BLOCKED','ERROR')),
  UNIQUE(file_id, version_number), UNIQUE(workspace_id, file_id, id),
  FOREIGN KEY(workspace_id, file_id) REFERENCES drive_files(workspace_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE drive_files ADD FOREIGN KEY(workspace_id, id, current_version_id) REFERENCES drive_file_versions(workspace_id, file_id, id) DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION drive_version_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'scan_status') IS DISTINCT FROM (to_jsonb(OLD) - 'scan_status') OR OLD.scan_status = 'BLOCKED' AND NEW.scan_status <> 'BLOCKED' THEN
    RAISE EXCEPTION 'FILE_VERSION_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER drive_version_immutable BEFORE UPDATE ON drive_file_versions FOR EACH ROW EXECUTE FUNCTION drive_version_immutable();

CREATE FUNCTION drive_file_current_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target UUID; file drive_files%ROWTYPE; current drive_file_versions%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'drive_files' THEN target := COALESCE(NEW.id, OLD.id); ELSE target := COALESCE(NEW.file_id, OLD.file_id); END IF;
  SELECT * INTO file FROM drive_files WHERE id = target;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF file.current_version_id IS NULL THEN
    IF file.status IN ('ACTIVE','BLOCKED') OR file.size_bytes_current <> 0 THEN RAISE EXCEPTION 'FILE_VERSION_INVALID' USING ERRCODE = '23514'; END IF;
  ELSE
    SELECT * INTO current FROM drive_file_versions WHERE id = file.current_version_id AND file_id = file.id AND workspace_id = file.workspace_id;
    IF NOT FOUND OR current.size_bytes <> file.size_bytes_current OR current.mime_type <> file.mime_type OR
      file.status = 'ACTIVE' AND current.scan_status <> 'CLEAN' OR file.status = 'BLOCKED' AND current.scan_status <> 'BLOCKED' THEN RAISE EXCEPTION 'FILE_VERSION_INVALID' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER drive_file_current_guard AFTER INSERT OR UPDATE ON drive_files DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION drive_file_current_guard();
CREATE CONSTRAINT TRIGGER drive_version_current_guard AFTER INSERT OR UPDATE OR DELETE ON drive_file_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION drive_file_current_guard();

CREATE FUNCTION drive_file_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.workspace_id <> OLD.workspace_id OR NEW.storage_id <> OLD.storage_id OR NEW.created_at <> OLD.created_at OR
    NEW.public_share_version < OLD.public_share_version OR NEW.version < OLD.version THEN RAISE EXCEPTION 'FILE_VERSION_INVALID' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER drive_file_identity_guard BEFORE UPDATE ON drive_files FOR EACH ROW EXECUTE FUNCTION drive_file_identity_guard();
CREATE TRIGGER drive_file_revision BEFORE INSERT OR UPDATE OR DELETE ON drive_files FOR EACH ROW EXECUTE FUNCTION calendar_booking_source_epoch();
CREATE TRIGGER drive_version_revision BEFORE INSERT OR UPDATE OR DELETE ON drive_file_versions FOR EACH ROW EXECUTE FUNCTION calendar_booking_source_epoch();

-- Extend the existing resource tenant guard without relaxing any subject validation.
ALTER TABLE file_permission_assignments DROP CONSTRAINT file_permission_assignments_resource_type_check;
ALTER TABLE file_permission_assignments ADD CHECK(resource_type IN ('STORAGE','FOLDER','FILE'));
CREATE FUNCTION drive_permission_resource_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.resource_type = 'FILE' AND NOT EXISTS(SELECT 1 FROM drive_files WHERE id = NEW.resource_id AND workspace_id = NEW.workspace_id) THEN
    RAISE EXCEPTION 'FILE_PERMISSION_INVALID' USING ERRCODE = '23514';
  END IF;
  IF NEW.resource_type = 'FILE' AND NEW.subject_type = 'PROJECT_ROLE' AND NOT EXISTS(SELECT 1 FROM drive_files f JOIN file_storages s ON s.id = f.storage_id
    JOIN projects p ON p.id = s.project_id WHERE f.id = NEW.resource_id AND f.workspace_id = NEW.workspace_id AND NOT p.is_deleted) THEN
    RAISE EXCEPTION 'FILE_PERMISSION_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER drive_permission_resource_guard BEFORE INSERT OR UPDATE ON file_permission_assignments FOR EACH ROW EXECUTE FUNCTION drive_permission_resource_guard();
-- The live-subject trigger needs the owning storage for FILE Project-role assignments.
CREATE OR REPLACE FUNCTION file_permission_live_subject_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE storage UUID;
BEGIN
  IF NEW.subject_type = 'WORKSPACE' AND NEW.subject_id = NEW.workspace_id::text THEN NEW.subject_id := NULL; END IF;
  IF NEW.resource_type = 'STORAGE' THEN storage := NEW.resource_id;
  ELSIF NEW.resource_type = 'FILE' THEN SELECT storage_id INTO storage FROM drive_files WHERE id = NEW.resource_id AND workspace_id = NEW.workspace_id;
  ELSE SELECT storage_id INTO storage FROM file_folders WHERE id = NEW.resource_id AND workspace_id = NEW.workspace_id; END IF;
  IF (NEW.subject_type = 'USER' AND NOT EXISTS(SELECT 1 FROM workspace_memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = NEW.workspace_id AND m.user_id::text = NEW.subject_id AND m.status = 'ACTIVE' AND u.status = 'ACTIVE' AND NOT u.is_deleted)) OR
    (NEW.subject_type = 'ROLE' AND NOT EXISTS(SELECT 1 FROM roles WHERE id::text = NEW.subject_id AND workspace_id = NEW.workspace_id AND NOT is_deleted)) OR
    (NEW.subject_type IN ('DEPARTMENT','DEPARTMENT_TREE') AND NOT EXISTS(SELECT 1 FROM departments WHERE id::text = NEW.subject_id AND workspace_id = NEW.workspace_id AND NOT is_deleted)) OR
    (NEW.subject_type = 'PROJECT_ROLE' AND NOT EXISTS(SELECT 1 FROM file_storages s JOIN projects p ON p.id = s.project_id WHERE s.id = storage AND s.workspace_id = NEW.workspace_id AND NOT p.is_deleted)) OR
    (NEW.subject_type = 'EXTERNAL_GUEST' AND NOT EXISTS(SELECT 1 FROM collab_space_members m JOIN collab_spaces c ON c.id = m.collab_id WHERE m.workspace_id = NEW.workspace_id AND c.workspace_id = NEW.workspace_id AND m.user_id::text = NEW.subject_id AND m.member_type = 'EXTERNAL' AND m.status = 'ACTIVE' AND m.left_at IS NULL AND c.status = 'ACTIVE')) THEN
    RAISE EXCEPTION 'FILE_PERMISSION_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION drive_version_quota_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE max_file DOUBLE PRECISION := 104857600; max_storage DOUBLE PRECISION := 5368709120; policy JSONB; grant_row JSONB; usage DOUBLE PRECISION;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM drive_file_versions WHERE id = NEW.id) THEN RETURN NULL; END IF;
  SELECT settings INTO policy FROM workspaces WHERE id = NEW.workspace_id;
  IF policy ? 'fileMaxBytes' THEN max_file := LEAST(max_file, (policy->>'fileMaxBytes')::double precision); END IF;
  IF policy ? 'fileStorageQuotaBytes' THEN max_storage := LEAST(max_storage, (policy->>'fileStorageQuotaBytes')::double precision); END IF;
  FOR grant_row IN SELECT data FROM commercial_pack_records WHERE workspace_id = NEW.workspace_id AND collection = 'entitlementGrants' AND data->>'capability' IN ('files.max_file_bytes','files.storage_bytes') LOOP
    IF grant_row->>'enabled' = 'false' THEN
      IF grant_row->>'capability' = 'files.max_file_bytes' THEN max_file := 0; ELSE max_storage := 0; END IF;
    ELSIF grant_row->>'limit' IS NOT NULL THEN
      IF grant_row->>'capability' = 'files.max_file_bytes' THEN max_file := LEAST(max_file, (grant_row->>'limit')::double precision);
      ELSE max_storage := LEAST(max_storage, (grant_row->>'limit')::double precision); END IF;
    END IF;
  END LOOP;
  IF max_file < 0 OR max_storage < 0 OR max_file <> floor(max_file) OR max_storage <> floor(max_storage) THEN RAISE EXCEPTION 'FILE_QUOTA_POLICY_INVALID' USING ERRCODE = '23514'; END IF;
  IF NEW.size_bytes > max_file THEN RAISE EXCEPTION 'FILE_TOO_LARGE' USING ERRCODE = '23514'; END IF;
  SELECT COALESCE(SUM(size_bytes), 0) INTO usage FROM drive_file_versions WHERE workspace_id = NEW.workspace_id;
  IF usage > max_storage THEN RAISE EXCEPTION 'STORAGE_QUOTA_EXCEEDED' USING ERRCODE = '23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER drive_version_quota_guard AFTER INSERT ON drive_file_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION drive_version_quota_guard();

CREATE OR REPLACE FUNCTION file_retention_source_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE scope UUID;
BEGIN
  FOR scope IN SELECT DISTINCT candidate FROM (
    SELECT (to_jsonb(NEW)->>'workspace_id')::uuid AS candidate WHERE to_jsonb(NEW)->>'collection' IN ('retentionRecords','entitlementGrants')
    UNION SELECT (to_jsonb(OLD)->>'workspace_id')::uuid WHERE to_jsonb(OLD)->>'collection' IN ('retentionRecords','entitlementGrants')
  ) sources WHERE candidate IS NOT NULL ORDER BY candidate LOOP
    PERFORM calendar_booking_lock_workspace(scope);
    UPDATE calendar_availability_epochs SET epoch = epoch + 1 WHERE workspace_id = scope;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;

CREATE FUNCTION drive_file_retention_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ids UUID[]; trashed_parent BOOLEAN;
BEGIN
  PERFORM calendar_booking_lock_workspace(OLD.workspace_id);
  WITH RECURSIVE ancestors AS (
    SELECT id, parent_folder_id, status FROM file_folders WHERE id = OLD.folder_id AND workspace_id = OLD.workspace_id
    UNION ALL SELECT f.id, f.parent_folder_id, f.status FROM file_folders f JOIN ancestors a ON f.id = a.parent_folder_id WHERE f.workspace_id = OLD.workspace_id AND f.storage_id = OLD.storage_id
  ) SELECT array_agg(id), COALESCE(bool_or(status = 'TRASHED'), false) INTO ids, trashed_parent FROM ancestors;
  IF OLD.status <> 'TRASHED' AND NOT trashed_parent THEN RAISE EXCEPTION 'FILE_STATE_INVALID' USING ERRCODE = '23514'; END IF;
  IF OLD.purge_after > CURRENT_TIMESTAMP OR EXISTS(SELECT 1 FROM file_folders WHERE id = ANY(ids) AND purge_after > CURRENT_TIMESTAMP) OR
    EXISTS(SELECT 1 FROM commercial_pack_records WHERE workspace_id = OLD.workspace_id AND collection = 'retentionRecords' AND (data->>'resourceId')::uuid = ANY(array_append(array_append(ids, OLD.id), OLD.storage_id))
      AND data->>'purgedAt' IS NULL AND (data->>'legalHold' = 'true' OR (data->>'expiresAt')::timestamptz > CURRENT_TIMESTAMP)) THEN
    RAISE EXCEPTION 'FILE_RETENTION_HOLD' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER drive_file_retention_guard BEFORE DELETE ON drive_files FOR EACH ROW EXECUTE FUNCTION drive_file_retention_guard();

ALTER TABLE drive_file_versions ADD CHECK(object_key LIKE workspace_id::text || '/%');
CREATE FUNCTION drive_object_alias_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source drive_file_versions%ROWTYPE;
BEGIN
  SELECT * INTO source FROM drive_file_versions WHERE id = NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF EXISTS(SELECT 1 FROM drive_file_versions alias WHERE alias.workspace_id = source.workspace_id AND alias.object_key = source.object_key AND
    (alias.size_bytes <> source.size_bytes OR alias.checksum <> source.checksum OR alias.mime_type <> source.mime_type OR alias.scan_status <> source.scan_status)) THEN
    RAISE EXCEPTION 'FILE_VERSION_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER drive_object_alias_guard AFTER INSERT OR UPDATE ON drive_file_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION drive_object_alias_guard();

CREATE FUNCTION drive_version_creator_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM workspace_memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = NEW.workspace_id AND m.user_id = NEW.created_by_user_id
    AND m.status = 'ACTIVE' AND NOT m.is_deleted AND u.status = 'ACTIVE' AND NOT u.is_deleted) THEN
    RAISE EXCEPTION 'FILE_VERSION_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER drive_version_creator_guard BEFORE INSERT ON drive_file_versions FOR EACH ROW EXECUTE FUNCTION drive_version_creator_guard();

CREATE FUNCTION drive_version_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM drive_files WHERE id = OLD.file_id AND workspace_id = OLD.workspace_id) THEN
    RAISE EXCEPTION 'FILE_VERSION_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER drive_version_delete_guard AFTER DELETE ON drive_file_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION drive_version_delete_guard();
