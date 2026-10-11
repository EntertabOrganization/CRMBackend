ALTER TABLE upload_sessions
 ADD COLUMN cleanup_claim_id UUID,
 ADD COLUMN cleanup_lease_expires_at TIMESTAMPTZ,
 ADD COLUMN cleanup_next_attempt_at TIMESTAMPTZ,
 ADD COLUMN cleanup_attempts INTEGER NOT NULL DEFAULT 0 CHECK(cleanup_attempts >= 0),
 ADD COLUMN cleanup_error_code TEXT,
 ADD COLUMN cleaned_at TIMESTAMPTZ,
 ADD CONSTRAINT upload_cleanup_lease_pair CHECK((cleanup_claim_id IS NULL) = (cleanup_lease_expires_at IS NULL)),
 ADD CONSTRAINT upload_cleanup_terminal CHECK(cleaned_at IS NULL OR (status IN ('ABORTED','FAILED') AND result_version_id IS NULL));
CREATE INDEX upload_cleanup_due ON upload_sessions(cleanup_next_attempt_at, expires_at, id) WHERE result_version_id IS NULL;
-- Multipart staging objects can never become immutable Version identities, including during cleanup I/O.
ALTER TABLE drive_file_versions ADD CONSTRAINT drive_version_not_staging CHECK(object_key NOT LIKE workspace_id::text || '/uploads/%');
CREATE OR REPLACE FUNCTION upload_session_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mutable TEXT[] := ARRAY['status','parts','result_file_id','result_version_id','version','updated_at',
 'cleanup_claim_id','cleanup_lease_expires_at','cleanup_next_attempt_at','cleanup_attempts','cleanup_error_code','cleaned_at'];
BEGIN
 IF TG_OP = 'INSERT' AND NOT EXISTS(SELECT 1 FROM workspace_memberships WHERE workspace_id = NEW.workspace_id AND user_id = NEW.created_by_user_id) THEN RAISE EXCEPTION 'UPLOAD_SESSION_NOT_FOUND' USING ERRCODE = '23514'; END IF;
 IF TG_OP = 'UPDATE' AND ((to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) OR NEW.version < OLD.version OR
   OLD.result_version_id IS NOT NULL AND (NEW.result_file_id IS DISTINCT FROM OLD.result_file_id OR NEW.result_version_id IS DISTINCT FROM OLD.result_version_id) OR
   OLD.status IN ('COMPLETED','ABORTED') AND NEW.status <> OLD.status OR
   OLD.status IN ('COMPLETED','ABORTED','FAILED') AND NEW.parts <> OLD.parts OR
   OLD.cleaned_at IS NOT NULL AND NEW.cleaned_at IS DISTINCT FROM OLD.cleaned_at OR NEW.cleanup_attempts < OLD.cleanup_attempts) THEN
  RAISE EXCEPTION 'UPLOAD_SESSION_STATE_INVALID' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;
