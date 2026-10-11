ALTER TABLE document_edit_sessions
 ADD COLUMN provider_ready BOOLEAN NOT NULL DEFAULT FALSE,
 ADD COLUMN save_request_hash TEXT CHECK(save_request_hash IS NULL OR save_request_hash ~ '^[a-f0-9]{64}$'),
 ADD COLUMN upload_session_id UUID,
 ADD COLUMN cleanup_required BOOLEAN NOT NULL DEFAULT FALSE,
 ADD COLUMN cleanup_claim_id UUID,
 ADD COLUMN cleanup_lease_expires_at TIMESTAMPTZ,
 ADD COLUMN cleanup_next_attempt_at TIMESTAMPTZ,
 ADD COLUMN cleanup_attempts INTEGER NOT NULL DEFAULT 0 CHECK(cleanup_attempts >= 0),
 ADD COLUMN cleanup_error_code TEXT;
ALTER TABLE upload_sessions ADD COLUMN edit_session_id UUID;
CREATE INDEX document_edit_cleanup_due ON document_edit_sessions(cleanup_next_attempt_at) WHERE cleanup_required;

CREATE OR REPLACE FUNCTION document_edit_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cleanup_keys TEXT[] := ARRAY['cleanup_required','cleanup_claim_id','cleanup_lease_expires_at','cleanup_next_attempt_at','cleanup_attempts','cleanup_error_code','version'];
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'EDIT_SESSION_PROOF_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' THEN
  IF (NEW.id,NEW.workspace_id,NEW.file_id,NEW.provider,NEW.provider_session_id,NEW.user_id,NEW.mode,NEW.started_at,NEW.lock_id,NEW.base_version_id)
   IS DISTINCT FROM (OLD.id,OLD.workspace_id,OLD.file_id,OLD.provider,OLD.provider_session_id,OLD.user_id,OLD.mode,OLD.started_at,OLD.lock_id,OLD.base_version_id)
   OR OLD.status<>'ACTIVE' AND (to_jsonb(NEW)-cleanup_keys) IS DISTINCT FROM (to_jsonb(OLD)-cleanup_keys)
   OR OLD.expires_at<=clock_timestamp() AND OLD.status='ACTIVE' AND (NEW.status='ACTIVE' AND NEW IS DISTINCT FROM OLD OR NEW.status='COMPLETED')
   OR NEW.last_activity_at<OLD.last_activity_at OR NEW.expires_at<OLD.expires_at
   OR OLD.provider_ready AND NOT NEW.provider_ready
   OR OLD.save_request_hash IS NOT NULL AND NEW.save_request_hash IS DISTINCT FROM OLD.save_request_hash
   OR OLD.upload_session_id IS NOT NULL AND NEW.upload_session_id IS DISTINCT FROM OLD.upload_session_id
   OR NEW IS DISTINCT FROM OLD AND NEW.version<>OLD.version+1
  THEN RAISE EXCEPTION 'EDIT_SESSION_PROOF_IMMUTABLE' USING ERRCODE='23514'; END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM document_edit_sessions WHERE id=NEW.id) THEN RETURN NEW; END IF;
  PERFORM calendar_booking_lock_workspace(NEW.workspace_id);
  IF NEW.status<>'ACTIVE' OR NEW.provider_ready OR NEW.save_request_hash IS NOT NULL OR NEW.upload_session_id IS NOT NULL
   OR NEW.provider_session_id<>NEW.id::text OR NEW.started_at>clock_timestamp()+INTERVAL '5 seconds' OR NEW.expires_at<=clock_timestamp()
   OR NEW.expires_at>NEW.started_at+INTERVAL '15 minutes'
   OR NOT EXISTS(SELECT 1 FROM drive_files f JOIN drive_file_versions v ON v.id=f.current_version_id AND v.workspace_id=f.workspace_id AND v.file_id=f.id
    WHERE f.workspace_id=NEW.workspace_id AND f.id=NEW.file_id AND f.status='ACTIVE' AND v.id=NEW.base_version_id AND v.scan_status='CLEAN' AND v.processed_at IS NOT NULL)
   OR NOT EXISTS(SELECT 1 FROM workspace_memberships WHERE workspace_id=NEW.workspace_id AND user_id=NEW.user_id AND status='ACTIVE')
  THEN RAISE EXCEPTION 'FILE_NOT_EDITABLE' USING ERRCODE='23514'; END IF;
  IF NEW.mode='COLLABORATIVE' AND EXISTS(SELECT 1 FROM file_locks WHERE workspace_id=NEW.workspace_id AND file_id=NEW.file_id AND released_at IS NULL AND expires_at>clock_timestamp())
   THEN RAISE EXCEPTION 'FILE_LOCKED' USING ERRCODE='23514'; END IF;
  IF NEW.mode='EXCLUSIVE_LOCK' AND NOT EXISTS(SELECT 1 FROM file_locks WHERE id=NEW.lock_id AND workspace_id=NEW.workspace_id AND file_id=NEW.file_id AND lock_type='EDIT' AND locked_by_user_id=NEW.user_id AND released_at IS NULL AND expires_at>=NEW.expires_at)
   THEN RAISE EXCEPTION 'EDIT_SESSION_EXPIRED' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.status='ACTIVE' AND NEW.expires_at>clock_timestamp()+INTERVAL '15 minutes 5 seconds' THEN RAISE EXCEPTION 'EDIT_SESSION_EXPIRED' USING ERRCODE='23514'; END IF;
 IF NEW.upload_session_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM upload_sessions u WHERE u.id=NEW.upload_session_id AND u.edit_session_id=NEW.id AND u.workspace_id=NEW.workspace_id AND u.created_by_user_id=NEW.user_id AND u.target_file_id=NEW.file_id)
 THEN RAISE EXCEPTION 'EDIT_SESSION_PROOF_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND OLD.status='ACTIVE' AND NEW.status='COMPLETED' AND
  (NOT NEW.provider_ready OR NEW.save_request_hash IS NULL OR NOT EXISTS(SELECT 1 FROM upload_sessions u JOIN drive_file_versions v ON v.id=u.result_version_id AND v.workspace_id=u.workspace_id AND v.file_id=u.target_file_id
   WHERE u.id=NEW.upload_session_id AND u.edit_session_id=NEW.id AND u.workspace_id=NEW.workspace_id AND u.created_by_user_id=NEW.user_id AND u.target_file_id=NEW.file_id AND u.result_version_id=NEW.result_version_id AND u.status IN ('COMPLETED','PROCESSING')))
 THEN RAISE EXCEPTION 'EDIT_SESSION_PROOF_IMMUTABLE' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION upload_edit_origin_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.edit_session_id IS DISTINCT FROM OLD.edit_session_id THEN RAISE EXCEPTION 'EDIT_SESSION_PROOF_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM upload_sessions WHERE id=NEW.id) AND NEW.edit_session_id IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM document_edit_sessions d WHERE d.id=NEW.edit_session_id AND d.workspace_id=NEW.workspace_id AND d.user_id=NEW.created_by_user_id
   AND d.file_id=NEW.target_file_id AND d.status='ACTIVE' AND d.provider_ready AND d.save_request_hash IS NOT NULL AND d.expires_at>clock_timestamp())
  THEN RAISE EXCEPTION 'EDIT_SESSION_EXPIRED' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER upload_edit_origin_guard BEFORE INSERT OR UPDATE ON upload_sessions FOR EACH ROW EXECUTE FUNCTION upload_edit_origin_guard();

CREATE FUNCTION upload_edit_pair_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.edit_session_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM document_edit_sessions d JOIN upload_sessions u ON u.id=d.upload_session_id
  WHERE u.id=NEW.id AND d.id=u.edit_session_id AND d.workspace_id=u.workspace_id AND d.user_id=u.created_by_user_id AND d.file_id=u.target_file_id
   AND (u.result_version_id IS NULL OR d.status='COMPLETED' AND d.result_version_id=u.result_version_id))
 THEN RAISE EXCEPTION 'EDIT_SESSION_PROOF_IMMUTABLE' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER upload_edit_pair_guard AFTER INSERT OR UPDATE ON upload_sessions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION upload_edit_pair_guard();
