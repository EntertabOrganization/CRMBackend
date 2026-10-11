CREATE TABLE file_delivery_grants (
 id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
 file_id UUID NOT NULL, version_id UUID NOT NULL, user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 token_hash TEXT NOT NULL CHECK(token_hash ~ '^[a-f0-9]{64}$'), expires_at TIMESTAMPTZ NOT NULL,
 consumed_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL,
 CHECK(expires_at > created_at AND expires_at <= created_at + interval '2 minutes'),
 CHECK(consumed_at IS NULL OR consumed_at >= created_at AND consumed_at < expires_at)
);
CREATE INDEX file_delivery_grants_file ON file_delivery_grants(workspace_id, file_id);
CREATE TRIGGER file_delivery_revision BEFORE INSERT OR UPDATE OR DELETE ON file_delivery_grants
 FOR EACH ROW EXECUTE FUNCTION calendar_booking_source_epoch();
CREATE FUNCTION file_delivery_grant_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'UPDATE' AND ((to_jsonb(NEW) - 'consumed_at') IS DISTINCT FROM (to_jsonb(OLD) - 'consumed_at') OR
   OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at) THEN
   RAISE EXCEPTION 'FILE_DELIVERY_UNAVAILABLE' USING ERRCODE = '23514';
 END IF;
 IF TG_OP = 'INSERT' AND NOT EXISTS(SELECT 1 FROM file_delivery_grants WHERE id = NEW.id) AND NOT EXISTS(
   SELECT 1 FROM drive_file_versions v JOIN drive_files f ON f.id = v.file_id AND f.workspace_id = v.workspace_id
    JOIN workspace_memberships m ON m.workspace_id = f.workspace_id AND m.user_id = NEW.user_id AND m.status = 'ACTIVE'
    WHERE v.id = NEW.version_id AND v.file_id = NEW.file_id AND v.workspace_id = NEW.workspace_id
     AND f.current_version_id = v.id AND f.status = 'ACTIVE' AND v.scan_status = 'CLEAN' AND v.processed_at IS NOT NULL) THEN
   RAISE EXCEPTION 'FILE_DELIVERY_UNAVAILABLE' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER file_delivery_grant_guard BEFORE INSERT OR UPDATE ON file_delivery_grants FOR EACH ROW EXECUTE FUNCTION file_delivery_grant_guard();
CREATE TRIGGER file_delivery_binding_authority BEFORE INSERT OR UPDATE OR DELETE ON tasks FOR EACH ROW EXECUTE FUNCTION calendar_booking_source_epoch();
CREATE TRIGGER file_delivery_binding_authority BEFORE INSERT OR UPDATE OR DELETE ON task_members FOR EACH ROW EXECUTE FUNCTION calendar_booking_source_epoch();
CREATE TRIGGER file_delivery_binding_authority BEFORE INSERT OR UPDATE OR DELETE ON projects FOR EACH ROW EXECUTE FUNCTION calendar_booking_source_epoch();
CREATE TRIGGER file_delivery_binding_authority BEFORE INSERT OR UPDATE OR DELETE ON project_members FOR EACH ROW EXECUTE FUNCTION calendar_booking_source_epoch();
CREATE TRIGGER file_delivery_binding_authority BEFORE INSERT OR UPDATE OR DELETE ON calendars FOR EACH ROW EXECUTE FUNCTION calendar_booking_source_epoch();
CREATE TRIGGER file_delivery_binding_authority BEFORE INSERT OR UPDATE OR DELETE ON calendar_permissions FOR EACH ROW EXECUTE FUNCTION calendar_booking_source_epoch();
