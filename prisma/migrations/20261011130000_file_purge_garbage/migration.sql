CREATE TABLE file_object_garbage (
 id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
 object_key TEXT NOT NULL CHECK(object_key LIKE workspace_id::text || '/objects/%'),
 claim_id UUID, lease_expires_at TIMESTAMPTZ, next_attempt_at TIMESTAMPTZ NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0), error_code TEXT, cleaned_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
 UNIQUE(workspace_id, object_key), CHECK((claim_id IS NULL) = (lease_expires_at IS NULL))
);
CREATE INDEX file_object_garbage_due ON file_object_garbage(next_attempt_at, id);
CREATE TRIGGER file_object_garbage_revision BEFORE INSERT OR UPDATE OR DELETE ON file_object_garbage
 FOR EACH ROW EXECUTE FUNCTION calendar_booking_source_epoch();
CREATE FUNCTION file_object_retirement_permanent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'FILE_OBJECT_CLEANUP_UNSAFE' USING ERRCODE = '23514'; END $$;
CREATE TRIGGER file_object_retirement_permanent BEFORE DELETE ON file_object_garbage FOR EACH ROW EXECUTE FUNCTION file_object_retirement_permanent();
CREATE FUNCTION file_object_retirement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM calendar_booking_lock_workspace(NEW.workspace_id);
 IF TG_TABLE_NAME = 'drive_file_versions' THEN
   IF EXISTS(SELECT 1 FROM file_object_garbage WHERE workspace_id = NEW.workspace_id AND object_key = NEW.object_key) THEN
     RAISE EXCEPTION 'FILE_OBJECT_RETIRED' USING ERRCODE = '23514';
   END IF;
 ELSE
   IF TG_OP = 'UPDATE' AND ((to_jsonb(NEW) - ARRAY['claim_id','lease_expires_at','next_attempt_at','attempts','error_code','cleaned_at','updated_at']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['claim_id','lease_expires_at','next_attempt_at','attempts','error_code','cleaned_at','updated_at']) OR
     NEW.attempts < OLD.attempts OR OLD.cleaned_at IS NOT NULL AND NEW.cleaned_at IS DISTINCT FROM OLD.cleaned_at) THEN
     RAISE EXCEPTION 'FILE_OBJECT_CLEANUP_UNSAFE' USING ERRCODE = '23514';
   END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER file_object_retirement_guard BEFORE INSERT OR UPDATE ON file_object_garbage FOR EACH ROW EXECUTE FUNCTION file_object_retirement_guard();
CREATE TRIGGER drive_object_retirement_guard BEFORE INSERT OR UPDATE ON drive_file_versions FOR EACH ROW EXECUTE FUNCTION file_object_retirement_guard();
CREATE FUNCTION file_object_garbage_reference_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM drive_file_versions WHERE object_key = NEW.object_key) THEN
   RAISE EXCEPTION 'FILE_OBJECT_CLEANUP_UNSAFE' USING ERRCODE = '23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER file_object_garbage_reference_guard AFTER INSERT OR UPDATE ON file_object_garbage
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION file_object_garbage_reference_guard();
CREATE FUNCTION drive_object_retire_deleted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM drive_file_versions WHERE object_key = OLD.object_key) THEN
   INSERT INTO file_object_garbage(id, workspace_id, object_key, next_attempt_at, created_at, updated_at)
     VALUES(gen_random_uuid(), OLD.workspace_id, OLD.object_key, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(workspace_id, object_key) DO NOTHING;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER drive_object_retire_deleted AFTER DELETE ON drive_file_versions FOR EACH ROW EXECUTE FUNCTION drive_object_retire_deleted();

ALTER TABLE upload_sessions ADD COLUMN purged_at TIMESTAMPTZ;
ALTER TABLE upload_sessions ADD CONSTRAINT upload_purged_processing_closed CHECK(purged_at IS NULL OR
 (processing_claim_id IS NULL AND processing_lease_expires_at IS NULL AND processing_next_attempt_at IS NULL));
-- Keep immutable protocol identity and idempotency receipts after their content/target is purged.
-- The deferred guard below validates all live relationships, including SQL bypass attempts.
DO $$ DECLARE item RECORD; BEGIN
 FOR item IN SELECT conname FROM pg_constraint WHERE conrelid = 'upload_sessions'::regclass AND contype = 'f'
   AND confrelid IN ('file_folders'::regclass, 'drive_files'::regclass, 'drive_file_versions'::regclass) LOOP
   EXECUTE format('ALTER TABLE upload_sessions DROP CONSTRAINT %I', item.conname);
 END LOOP;
END $$;
CREATE FUNCTION upload_session_live_parents_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE live upload_sessions%ROWTYPE;
BEGIN
 SELECT * INTO live FROM upload_sessions WHERE id = NEW.id;
 IF NOT FOUND OR live.purged_at IS NOT NULL THEN RETURN NULL; END IF;
 IF live.result_version_id IS NOT NULL THEN
   IF NOT EXISTS(SELECT 1 FROM drive_file_versions WHERE id = live.result_version_id AND file_id = live.result_file_id AND workspace_id = live.workspace_id) THEN
     RAISE EXCEPTION 'UPLOAD_SESSION_STATE_INVALID' USING ERRCODE = '23514';
   END IF;
 ELSIF NOT EXISTS(SELECT 1 FROM file_folders WHERE id = live.target_folder_id AND workspace_id = live.workspace_id) THEN
   RAISE EXCEPTION 'UPLOAD_SESSION_NOT_FOUND' USING ERRCODE = '23514';
 END IF;
 IF live.target_file_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM drive_files WHERE id = live.target_file_id AND workspace_id = live.workspace_id) THEN
   RAISE EXCEPTION 'UPLOAD_SESSION_NOT_FOUND' USING ERRCODE = '23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER upload_session_live_parents_guard AFTER INSERT OR UPDATE ON upload_sessions
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION upload_session_live_parents_guard();
CREATE FUNCTION upload_session_parent_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM upload_sessions s WHERE s.workspace_id = OLD.workspace_id AND s.purged_at IS NULL AND (
   TG_TABLE_NAME = 'drive_files' AND (s.target_file_id = OLD.id OR s.result_file_id = OLD.id) OR
   TG_TABLE_NAME = 'drive_file_versions' AND s.result_version_id = OLD.id OR
   TG_TABLE_NAME = 'file_folders' AND s.target_folder_id = OLD.id AND s.result_version_id IS NULL)) THEN
   RAISE EXCEPTION 'UPLOAD_SESSION_STATE_INVALID' USING ERRCODE = '23514';
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER upload_session_file_delete_guard BEFORE DELETE ON drive_files FOR EACH ROW EXECUTE FUNCTION upload_session_parent_delete_guard();
CREATE TRIGGER upload_session_version_delete_guard BEFORE DELETE ON drive_file_versions FOR EACH ROW EXECUTE FUNCTION upload_session_parent_delete_guard();
CREATE TRIGGER upload_session_folder_delete_guard BEFORE DELETE ON file_folders FOR EACH ROW EXECUTE FUNCTION upload_session_parent_delete_guard();
CREATE OR REPLACE FUNCTION upload_session_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mutable TEXT[] := ARRAY['status','parts','result_file_id','result_version_id','version','updated_at','purged_at',
 'cleanup_claim_id','cleanup_lease_expires_at','cleanup_next_attempt_at','cleanup_attempts','cleanup_error_code','cleaned_at',
 'processing_claim_id','processing_lease_expires_at','processing_next_attempt_at','processing_attempts','processing_error_code'];
BEGIN
 IF TG_OP = 'INSERT' AND NOT EXISTS(SELECT 1 FROM workspace_memberships WHERE workspace_id = NEW.workspace_id AND user_id = NEW.created_by_user_id) THEN RAISE EXCEPTION 'UPLOAD_SESSION_NOT_FOUND' USING ERRCODE = '23514'; END IF;
 IF TG_OP = 'UPDATE' AND ((to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) OR NEW.version < OLD.version OR
   OLD.result_version_id IS NOT NULL AND (NEW.result_file_id IS DISTINCT FROM OLD.result_file_id OR NEW.result_version_id IS DISTINCT FROM OLD.result_version_id) OR
   OLD.status IN ('COMPLETED','ABORTED') AND NEW.status <> OLD.status OR
   OLD.status IN ('COMPLETED','ABORTED','FAILED') AND NEW.parts <> OLD.parts OR
   OLD.cleaned_at IS NOT NULL AND NEW.cleaned_at IS DISTINCT FROM OLD.cleaned_at OR NEW.cleanup_attempts < OLD.cleanup_attempts OR NEW.processing_attempts < OLD.processing_attempts OR
   OLD.purged_at IS NOT NULL AND (NEW.purged_at IS DISTINCT FROM OLD.purged_at OR NEW.status <> OLD.status OR NEW.parts <> OLD.parts OR
     NEW.result_file_id IS DISTINCT FROM OLD.result_file_id OR NEW.result_version_id IS DISTINCT FROM OLD.result_version_id)) THEN
  RAISE EXCEPTION 'UPLOAD_SESSION_STATE_INVALID' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION drive_version_purge_retention_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE file drive_files%ROWTYPE; ids UUID[]; inherited_trash BOOLEAN;
BEGIN
 PERFORM calendar_booking_lock_workspace(OLD.workspace_id);
 SELECT * INTO file FROM drive_files WHERE id = OLD.file_id AND workspace_id = OLD.workspace_id;
 IF NOT FOUND THEN RETURN OLD; END IF; -- File delete guard validated retention before parent deletion.
 WITH RECURSIVE ancestors AS (
   SELECT id, parent_folder_id, status FROM file_folders WHERE id = file.folder_id AND workspace_id = OLD.workspace_id
   UNION ALL SELECT f.id, f.parent_folder_id, f.status FROM file_folders f JOIN ancestors a ON f.id = a.parent_folder_id
     WHERE f.workspace_id = OLD.workspace_id AND f.storage_id = file.storage_id
 ) SELECT array_agg(id), COALESCE(bool_or(status = 'TRASHED'), false) INTO ids, inherited_trash FROM ancestors;
 IF file.status <> 'TRASHED' AND NOT inherited_trash THEN RAISE EXCEPTION 'FILE_STATE_INVALID' USING ERRCODE = '23514'; END IF;
 IF file.purge_after > CURRENT_TIMESTAMP OR EXISTS(SELECT 1 FROM file_folders WHERE id = ANY(ids) AND purge_after > CURRENT_TIMESTAMP) OR
   EXISTS(SELECT 1 FROM commercial_pack_records WHERE workspace_id = OLD.workspace_id AND collection = 'retentionRecords'
     AND (data->>'resourceId')::uuid = ANY(array_append(array_append(array_append(ids, file.id), file.storage_id), OLD.id))
     AND data->>'purgedAt' IS NULL AND (data->>'legalHold' = 'true' OR (data->>'expiresAt')::timestamptz > CURRENT_TIMESTAMP)) THEN
   RAISE EXCEPTION 'FILE_RETENTION_HOLD' USING ERRCODE = '23514';
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER drive_version_purge_retention_guard BEFORE DELETE ON drive_file_versions FOR EACH ROW EXECUTE FUNCTION drive_version_purge_retention_guard();
CREATE FUNCTION drive_file_version_hold_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM drive_file_versions v JOIN commercial_pack_records r ON r.workspace_id = v.workspace_id
   WHERE v.file_id = OLD.id AND v.workspace_id = OLD.workspace_id AND r.collection = 'retentionRecords'
     AND (r.data->>'resourceId')::uuid = v.id AND r.data->>'purgedAt' IS NULL
     AND (r.data->>'legalHold' = 'true' OR (r.data->>'expiresAt')::timestamptz > CURRENT_TIMESTAMP)) THEN
   RAISE EXCEPTION 'FILE_RETENTION_HOLD' USING ERRCODE = '23514';
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER drive_file_version_hold_guard BEFORE DELETE ON drive_files FOR EACH ROW EXECUTE FUNCTION drive_file_version_hold_guard();
