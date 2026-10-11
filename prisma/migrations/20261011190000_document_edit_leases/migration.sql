CREATE TABLE file_locks (
 id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES workspaces(id), file_id UUID NOT NULL,
 lock_type TEXT NOT NULL CHECK(lock_type IN ('EDIT','SYSTEM_PROCESS','WORKFLOW')),
 locked_by_user_id UUID REFERENCES users(id), lock_token_hash TEXT NOT NULL CHECK(lock_token_hash ~ '^[a-f0-9]{64}$'),
 locked_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL, released_at TIMESTAMPTZ,
 version INTEGER NOT NULL CHECK(version > 0), CHECK(expires_at > locked_at),
 CONSTRAINT file_locks_exclusive EXCLUDE USING gist(workspace_id WITH =,file_id WITH =,tstzrange(locked_at,expires_at,'[)') WITH &&) WHERE(released_at IS NULL)
);
CREATE INDEX file_locks_file ON file_locks(workspace_id,file_id);
CREATE TABLE document_edit_sessions (
 id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES workspaces(id), file_id UUID NOT NULL,
 provider TEXT NOT NULL CHECK(provider IN ('INTERNAL_DOCS','GOOGLE_DOCS','MICROSOFT_OFFICE','ONLYOFFICE','CUSTOM')),
 provider_session_id TEXT NOT NULL, user_id UUID NOT NULL REFERENCES users(id),
 mode TEXT NOT NULL CHECK(mode IN ('COLLABORATIVE','EXCLUSIVE_LOCK')),
 status TEXT NOT NULL CHECK(status IN ('ACTIVE','COMPLETED','ABORTED','EXPIRED')),
 started_at TIMESTAMPTZ NOT NULL, last_activity_at TIMESTAMPTZ NOT NULL, ended_at TIMESTAMPTZ,
 expires_at TIMESTAMPTZ NOT NULL, lock_id UUID REFERENCES file_locks(id), base_version_id UUID NOT NULL,
 result_version_id UUID, version INTEGER NOT NULL CHECK(version > 0),
 CHECK((mode='EXCLUSIVE_LOCK')=(lock_id IS NOT NULL)),
 CHECK((status='ACTIVE')=(ended_at IS NULL)), CHECK((status='COMPLETED')=(result_version_id IS NOT NULL)),
 CHECK(expires_at > started_at AND last_activity_at >= started_at)
);
CREATE INDEX document_edit_sessions_file ON document_edit_sessions(workspace_id,file_id);
CREATE FUNCTION file_lock_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'FILE_LOCK_PROOF_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' THEN
  IF (NEW.id,NEW.workspace_id,NEW.file_id,NEW.lock_type,NEW.locked_by_user_id,NEW.lock_token_hash,NEW.locked_at)
    IS DISTINCT FROM (OLD.id,OLD.workspace_id,OLD.file_id,OLD.lock_type,OLD.locked_by_user_id,OLD.lock_token_hash,OLD.locked_at)
   OR OLD.released_at IS NOT NULL AND NEW IS DISTINCT FROM OLD
   OR OLD.expires_at <= clock_timestamp() AND NEW.expires_at IS DISTINCT FROM OLD.expires_at
   OR NEW.expires_at < OLD.expires_at OR NEW.version < OLD.version
   OR NEW IS DISTINCT FROM OLD AND NEW.version <> OLD.version+1
  THEN RAISE EXCEPTION 'FILE_LOCK_PROOF_IMMUTABLE' USING ERRCODE='23514'; END IF;
  IF NEW.expires_at > clock_timestamp()+INTERVAL '15 minutes 5 seconds' THEN RAISE EXCEPTION 'FILE_LOCKED' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF EXISTS(SELECT 1 FROM file_locks WHERE id=NEW.id) THEN RETURN NEW; END IF;
 PERFORM calendar_booking_lock_workspace(NEW.workspace_id);
 IF NEW.locked_at > clock_timestamp()+INTERVAL '5 seconds' OR NEW.expires_at <= clock_timestamp()
  OR NEW.expires_at > NEW.locked_at+INTERVAL '15 minutes'
  OR NOT EXISTS(SELECT 1 FROM drive_files f JOIN drive_file_versions v ON v.id=f.current_version_id AND v.workspace_id=f.workspace_id AND v.file_id=f.id
    WHERE f.workspace_id=NEW.workspace_id AND f.id=NEW.file_id AND f.status='ACTIVE' AND v.scan_status='CLEAN' AND v.processed_at IS NOT NULL)
  OR NEW.locked_by_user_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM workspace_memberships WHERE workspace_id=NEW.workspace_id AND user_id=NEW.locked_by_user_id AND status='ACTIVE')
 THEN RAISE EXCEPTION 'FILE_NOT_EDITABLE' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM document_edit_sessions WHERE workspace_id=NEW.workspace_id AND file_id=NEW.file_id AND status='ACTIVE' AND expires_at>clock_timestamp())
 THEN RAISE EXCEPTION 'FILE_LOCKED' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER file_lock_identity_guard BEFORE INSERT OR UPDATE OR DELETE ON file_locks FOR EACH ROW EXECUTE FUNCTION file_lock_identity_guard();
CREATE TRIGGER file_lock_source_epoch BEFORE INSERT OR UPDATE OR DELETE ON file_locks FOR EACH ROW EXECUTE FUNCTION calendar_booking_source_epoch();
CREATE FUNCTION document_edit_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'EDIT_SESSION_PROOF_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' THEN
  IF (NEW.id,NEW.workspace_id,NEW.file_id,NEW.provider,NEW.provider_session_id,NEW.user_id,NEW.mode,NEW.started_at,NEW.lock_id,NEW.base_version_id)
   IS DISTINCT FROM (OLD.id,OLD.workspace_id,OLD.file_id,OLD.provider,OLD.provider_session_id,OLD.user_id,OLD.mode,OLD.started_at,OLD.lock_id,OLD.base_version_id)
   OR OLD.status<>'ACTIVE' AND NEW IS DISTINCT FROM OLD
   OR OLD.expires_at <= clock_timestamp() AND (NEW.status='ACTIVE' AND NEW IS DISTINCT FROM OLD OR NEW.status='COMPLETED')
   OR NEW.last_activity_at < OLD.last_activity_at OR NEW.expires_at < OLD.expires_at
   OR NEW IS DISTINCT FROM OLD AND NEW.version <> OLD.version+1
  THEN RAISE EXCEPTION 'EDIT_SESSION_PROOF_IMMUTABLE' USING ERRCODE='23514'; END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM document_edit_sessions WHERE id=NEW.id) THEN RETURN NEW; END IF;
  PERFORM calendar_booking_lock_workspace(NEW.workspace_id);
  IF NEW.status<>'ACTIVE' OR NEW.started_at>clock_timestamp()+INTERVAL '5 seconds' OR NEW.expires_at<=clock_timestamp()
   OR NEW.expires_at>NEW.started_at+INTERVAL '15 minutes'
   OR NOT EXISTS(SELECT 1 FROM drive_files f JOIN drive_file_versions v ON v.id=f.current_version_id AND v.workspace_id=f.workspace_id AND v.file_id=f.id
   WHERE f.workspace_id=NEW.workspace_id AND f.id=NEW.file_id AND f.status='ACTIVE' AND v.id=NEW.base_version_id AND v.scan_status='CLEAN' AND v.processed_at IS NOT NULL)
   OR NOT EXISTS(SELECT 1 FROM workspace_memberships WHERE workspace_id=NEW.workspace_id AND user_id=NEW.user_id AND status='ACTIVE')
  THEN RAISE EXCEPTION 'FILE_NOT_EDITABLE' USING ERRCODE='23514'; END IF;
  IF NEW.mode='COLLABORATIVE' AND EXISTS(SELECT 1 FROM file_locks WHERE workspace_id=NEW.workspace_id AND file_id=NEW.file_id AND released_at IS NULL AND expires_at>clock_timestamp())
  THEN RAISE EXCEPTION 'FILE_LOCKED' USING ERRCODE='23514'; END IF;
  IF NEW.mode='EXCLUSIVE_LOCK' AND NOT EXISTS(SELECT 1 FROM file_locks WHERE id=NEW.lock_id AND workspace_id=NEW.workspace_id AND file_id=NEW.file_id AND locked_by_user_id=NEW.user_id AND released_at IS NULL AND expires_at>=NEW.expires_at)
  THEN RAISE EXCEPTION 'EDIT_SESSION_EXPIRED' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.status='ACTIVE' AND NEW.expires_at > clock_timestamp()+INTERVAL '15 minutes 5 seconds' THEN
  RAISE EXCEPTION 'EDIT_SESSION_EXPIRED' USING ERRCODE='23514'; END IF;
 IF NEW.status='COMPLETED' AND NOT EXISTS(SELECT 1 FROM drive_file_versions WHERE id=NEW.result_version_id AND workspace_id=NEW.workspace_id AND file_id=NEW.file_id)
 THEN RAISE EXCEPTION 'FILE_NOT_EDITABLE' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER document_edit_identity_guard BEFORE INSERT OR UPDATE OR DELETE ON document_edit_sessions FOR EACH ROW EXECUTE FUNCTION document_edit_identity_guard();
CREATE TRIGGER document_edit_source_epoch BEFORE INSERT OR UPDATE OR DELETE ON document_edit_sessions FOR EACH ROW EXECUTE FUNCTION calendar_booking_source_epoch();
CREATE FUNCTION file_active_lease_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE lease_file_id UUID; tenant_id UUID;
BEGIN
 IF TG_OP='UPDATE' AND (NEW.name,NEW.folder_id,NEW.status,NEW.current_version_id) IS NOT DISTINCT FROM (OLD.name,OLD.folder_id,OLD.status,OLD.current_version_id) THEN RETURN NULL; END IF;
 lease_file_id:=OLD.id; tenant_id:=OLD.workspace_id;
 IF EXISTS(SELECT 1 FROM file_locks f WHERE f.workspace_id=tenant_id AND f.file_id=lease_file_id AND released_at IS NULL AND expires_at>clock_timestamp()) THEN
  RAISE EXCEPTION 'FILE_LOCKED' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER file_active_lease_guard AFTER UPDATE OR DELETE ON drive_files DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION file_active_lease_guard();
