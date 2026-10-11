CREATE TABLE upload_sessions (
 id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
 created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, target_folder_id UUID NOT NULL,
 desired_file_name TEXT NOT NULL CHECK(length(btrim(desired_file_name)) BETWEEN 1 AND 500), mime_type TEXT NOT NULL,
 expected_size_bytes DOUBLE PRECISION NOT NULL CHECK(expected_size_bytes >= 0 AND expected_size_bytes <= 104857600 AND expected_size_bytes = floor(expected_size_bytes)),
 expected_checksum TEXT NOT NULL CHECK(expected_checksum ~ '^[a-f0-9]{64}$'), target_file_id UUID,
 status TEXT NOT NULL CHECK(status IN ('CREATED','UPLOADING','COMPLETING','PROCESSING','COMPLETED','ABORTED','FAILED')),
 conflict_mode TEXT CHECK(conflict_mode IN ('CREATE_VERSION','RENAME','CANCEL')), idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200), fingerprint TEXT NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL, parts JSONB NOT NULL CHECK(jsonb_typeof(parts) = 'array' AND jsonb_array_length(parts) <= 100),
 result_file_id UUID, result_version_id UUID, version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0), created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
 UNIQUE(workspace_id, created_by_user_id, idempotency_key),
 FOREIGN KEY(workspace_id, target_folder_id) REFERENCES file_folders(workspace_id, id) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id, target_file_id) REFERENCES drive_files(workspace_id, id) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id, result_file_id, result_version_id) REFERENCES drive_file_versions(workspace_id, file_id, id) DEFERRABLE INITIALLY DEFERRED,
 CHECK((result_file_id IS NULL) = (result_version_id IS NULL)), CHECK(status NOT IN ('PROCESSING','COMPLETED') OR result_version_id IS NOT NULL)
);
CREATE TRIGGER upload_session_revision BEFORE INSERT OR UPDATE OR DELETE ON upload_sessions FOR EACH ROW EXECUTE FUNCTION calendar_booking_source_epoch();
CREATE FUNCTION upload_session_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM workspace_memberships WHERE workspace_id = NEW.workspace_id AND user_id = NEW.created_by_user_id) THEN RAISE EXCEPTION 'UPLOAD_SESSION_NOT_FOUND' USING ERRCODE = '23514'; END IF;
 IF TG_OP = 'UPDATE' AND ((to_jsonb(NEW) - ARRAY['status','parts','result_file_id','result_version_id','version','updated_at']) IS DISTINCT FROM
   (to_jsonb(OLD) - ARRAY['status','parts','result_file_id','result_version_id','version','updated_at']) OR NEW.version < OLD.version OR
   OLD.result_version_id IS NOT NULL AND (NEW.result_file_id IS DISTINCT FROM OLD.result_file_id OR NEW.result_version_id IS DISTINCT FROM OLD.result_version_id) OR
   OLD.status IN ('COMPLETED','ABORTED') AND (NEW.status <> OLD.status OR NEW.parts <> OLD.parts)) THEN
  RAISE EXCEPTION 'UPLOAD_SESSION_STATE_INVALID' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER upload_session_identity_guard BEFORE INSERT OR UPDATE ON upload_sessions FOR EACH ROW EXECUTE FUNCTION upload_session_identity_guard();
CREATE FUNCTION file_effective_quota(p_workspace UUID, capability TEXT, setting TEXT, platform DOUBLE PRECISION) RETURNS DOUBLE PRECISION LANGUAGE plpgsql AS $$
DECLARE policy JSONB; grant_row JSONB; result DOUBLE PRECISION := platform;
BEGIN
 SELECT settings INTO policy FROM workspaces WHERE id = p_workspace;
 IF policy ? setting THEN
   IF jsonb_typeof(policy->setting) <> 'number' THEN RAISE EXCEPTION 'FILE_QUOTA_POLICY_INVALID' USING ERRCODE = '23514'; END IF;
   result := LEAST(result, (policy->>setting)::double precision);
 END IF;
 FOR grant_row IN SELECT data FROM commercial_pack_records WHERE workspace_id = p_workspace AND collection = 'entitlementGrants' AND data->>'capability' = capability LOOP
  IF grant_row->>'enabled' = 'false' THEN result := 0;
  ELSIF grant_row->>'limit' IS NOT NULL THEN
   IF jsonb_typeof(grant_row->'limit') <> 'number' THEN RAISE EXCEPTION 'FILE_QUOTA_POLICY_INVALID' USING ERRCODE = '23514'; END IF;
   result := LEAST(result, (grant_row->>'limit')::double precision);
  END IF;
 END LOOP;
 IF result < 0 OR result <> floor(result) THEN RAISE EXCEPTION 'FILE_QUOTA_POLICY_INVALID' USING ERRCODE = '23514'; END IF;
 RETURN result;
END $$;
CREATE FUNCTION file_reserved_usage(p_workspace UUID) RETURNS DOUBLE PRECISION LANGUAGE sql AS $$
 SELECT COALESCE((SELECT SUM(size_bytes) FROM drive_file_versions WHERE workspace_id = p_workspace), 0) +
 COALESCE((SELECT SUM(expected_size_bytes) FROM upload_sessions WHERE workspace_id = p_workspace AND result_version_id IS NULL AND status IN ('CREATED','UPLOADING','COMPLETING') AND expires_at > CURRENT_TIMESTAMP), 0)
$$;
CREATE OR REPLACE FUNCTION drive_version_quota_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM drive_file_versions WHERE id = NEW.id) THEN RETURN NULL; END IF;
 IF NEW.size_bytes > file_effective_quota(NEW.workspace_id, 'files.max_file_bytes', 'fileMaxBytes', 104857600) THEN RAISE EXCEPTION 'FILE_TOO_LARGE' USING ERRCODE = '23514'; END IF;
 IF file_reserved_usage(NEW.workspace_id) > file_effective_quota(NEW.workspace_id, 'files.storage_bytes', 'fileStorageQuotaBytes', 5368709120) THEN RAISE EXCEPTION 'STORAGE_QUOTA_EXCEEDED' USING ERRCODE = '23514'; END IF;
 RETURN NULL;
END $$;
CREATE FUNCTION upload_session_quota_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status NOT IN ('CREATED','UPLOADING','COMPLETING') OR NEW.result_version_id IS NOT NULL OR NEW.expires_at <= CURRENT_TIMESTAMP THEN RETURN NULL; END IF;
 IF NEW.expected_size_bytes > file_effective_quota(NEW.workspace_id, 'files.max_file_bytes', 'fileMaxBytes', 104857600) THEN RAISE EXCEPTION 'FILE_TOO_LARGE' USING ERRCODE = '23514'; END IF;
 IF file_reserved_usage(NEW.workspace_id) > file_effective_quota(NEW.workspace_id, 'files.storage_bytes', 'fileStorageQuotaBytes', 5368709120) THEN RAISE EXCEPTION 'STORAGE_QUOTA_EXCEEDED' USING ERRCODE = '23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER upload_session_quota_guard AFTER INSERT OR UPDATE ON upload_sessions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION upload_session_quota_guard();

ALTER TABLE drive_file_versions ADD COLUMN processed_at TIMESTAMPTZ;
UPDATE drive_file_versions SET processed_at = created_at WHERE scan_status = 'CLEAN';
CREATE OR REPLACE FUNCTION drive_version_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW) - ARRAY['scan_status','processed_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['scan_status','processed_at']) OR
   OLD.scan_status = 'BLOCKED' AND NEW.scan_status <> 'BLOCKED' OR OLD.processed_at IS NOT NULL AND NEW.processed_at IS DISTINCT FROM OLD.processed_at THEN
  RAISE EXCEPTION 'FILE_VERSION_IMMUTABLE' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION drive_processed_current_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM drive_files f JOIN drive_file_versions v ON v.id = f.current_version_id WHERE f.workspace_id = NEW.workspace_id AND f.status = 'ACTIVE' AND v.processed_at IS NULL) THEN
  RAISE EXCEPTION 'FILE_VERSION_INVALID' USING ERRCODE = '23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER drive_processed_current_guard AFTER INSERT OR UPDATE ON drive_files DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION drive_processed_current_guard();
