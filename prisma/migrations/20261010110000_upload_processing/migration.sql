ALTER TABLE upload_sessions
 ADD COLUMN processing_claim_id UUID,
 ADD COLUMN processing_lease_expires_at TIMESTAMPTZ,
 ADD COLUMN processing_next_attempt_at TIMESTAMPTZ,
 ADD COLUMN processing_attempts INTEGER NOT NULL DEFAULT 0 CHECK(processing_attempts >= 0),
 ADD COLUMN processing_error_code TEXT,
 ADD CONSTRAINT upload_processing_lease_pair CHECK((processing_claim_id IS NULL) = (processing_lease_expires_at IS NULL)),
 ADD CONSTRAINT upload_processing_lease_state CHECK(processing_claim_id IS NULL OR (status = 'PROCESSING' AND result_version_id IS NOT NULL));
CREATE INDEX upload_processing_due ON upload_sessions(processing_next_attempt_at, id) WHERE status = 'PROCESSING';
ALTER TABLE upload_sessions DROP CONSTRAINT upload_cleanup_terminal;
ALTER TABLE upload_sessions ADD CONSTRAINT upload_cleanup_terminal CHECK(cleaned_at IS NULL OR
 (status IN ('ABORTED','FAILED') AND result_version_id IS NULL) OR (status IN ('PROCESSING','COMPLETED') AND result_version_id IS NOT NULL));
CREATE OR REPLACE FUNCTION upload_session_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mutable TEXT[] := ARRAY['status','parts','result_file_id','result_version_id','version','updated_at',
 'cleanup_claim_id','cleanup_lease_expires_at','cleanup_next_attempt_at','cleanup_attempts','cleanup_error_code','cleaned_at',
 'processing_claim_id','processing_lease_expires_at','processing_next_attempt_at','processing_attempts','processing_error_code'];
BEGIN
 IF TG_OP = 'INSERT' AND NOT EXISTS(SELECT 1 FROM workspace_memberships WHERE workspace_id = NEW.workspace_id AND user_id = NEW.created_by_user_id) THEN RAISE EXCEPTION 'UPLOAD_SESSION_NOT_FOUND' USING ERRCODE = '23514'; END IF;
 IF TG_OP = 'UPDATE' AND ((to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) OR NEW.version < OLD.version OR
   OLD.result_version_id IS NOT NULL AND (NEW.result_file_id IS DISTINCT FROM OLD.result_file_id OR NEW.result_version_id IS DISTINCT FROM OLD.result_version_id) OR
   OLD.status IN ('COMPLETED','ABORTED') AND NEW.status <> OLD.status OR
   OLD.status IN ('COMPLETED','ABORTED','FAILED') AND NEW.parts <> OLD.parts OR
   OLD.cleaned_at IS NOT NULL AND NEW.cleaned_at IS DISTINCT FROM OLD.cleaned_at OR NEW.cleanup_attempts < OLD.cleanup_attempts OR NEW.processing_attempts < OLD.processing_attempts) THEN
  RAISE EXCEPTION 'UPLOAD_SESSION_STATE_INVALID' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;

-- Prisma persists changed Versions with INSERT ... ON CONFLICT UPDATE. Existing immutable identities
-- remain valid after creator revocation; the immutable UPDATE trigger still guards every identity field.
CREATE OR REPLACE FUNCTION drive_version_creator_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM drive_file_versions WHERE id = NEW.id) AND
    NOT EXISTS(SELECT 1 FROM workspace_memberships m JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = NEW.workspace_id AND m.user_id = NEW.created_by_user_id
      AND m.status = 'ACTIVE' AND NOT m.is_deleted AND u.status = 'ACTIVE' AND NOT u.is_deleted) THEN
   RAISE EXCEPTION 'FILE_VERSION_INVALID' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;
