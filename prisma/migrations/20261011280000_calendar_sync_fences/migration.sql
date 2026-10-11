-- Forward hardening of the external calendar sync foundation.
CREATE INDEX calendar_sync_connections_owner ON calendar_sync_connections(workspace_id, user_id, status);
CREATE INDEX calendar_sync_conflicts_workspace ON calendar_sync_conflicts(workspace_id, status, created_at);
ALTER TABLE calendar_sync_connections ADD CONSTRAINT calendar_sync_active_lease CHECK(status = 'ACTIVE' OR claim_id IS NULL);
ALTER TABLE calendar_sync_mappings ADD CONSTRAINT calendar_sync_mapping_identity UNIQUE(workspace_id, connection_id, id, local_event_id);
ALTER TABLE calendar_sync_conflicts ADD CONSTRAINT calendar_sync_conflict_event FOREIGN KEY(workspace_id, connection_id, mapping_id, local_event_id)
 REFERENCES calendar_sync_mappings(workspace_id, connection_id, id, local_event_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE calendar_sync_conflicts ADD CONSTRAINT calendar_sync_conflict_local_version CHECK(local_version > 0);
CREATE OR REPLACE FUNCTION calendar_sync_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE connection calendar_sync_connections%ROWTYPE;
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'CALENDAR_SYNC_HISTORY_IMMUTABLE' USING ERRCODE = '23514'; END IF;
 IF TG_OP = 'UPDATE' AND (OLD.id <> NEW.id OR OLD.workspace_id <> NEW.workspace_id) THEN
  RAISE EXCEPTION 'CALENDAR_SYNC_MAPPING_INVALID' USING ERRCODE = '23514';
 END IF;
 IF TG_TABLE_NAME = 'calendar_sync_connections' THEN
  IF TG_OP = 'UPDATE' AND (OLD.user_id <> NEW.user_id OR OLD.calendar_id <> NEW.calendar_id OR OLD.provider <> NEW.provider OR OLD.external_calendar_id <> NEW.external_calendar_id
    OR (OLD.status = 'DISCONNECTED' AND NEW.status <> 'DISCONNECTED')) THEN
   RAISE EXCEPTION 'CALENDAR_SYNC_MAPPING_INVALID' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' AND NOT EXISTS (SELECT 1 FROM workspace_memberships WHERE workspace_id = NEW.workspace_id AND user_id = NEW.user_id AND status = 'ACTIVE' AND NOT is_deleted) THEN
   RAISE EXCEPTION 'CALENDAR_SYNC_AUTH_REQUIRED' USING ERRCODE = '23514';
  END IF;
 ELSE
  SELECT * INTO connection FROM calendar_sync_connections WHERE id = NEW.connection_id AND workspace_id = NEW.workspace_id;
  IF TG_OP = 'UPDATE' AND OLD.connection_id <> NEW.connection_id THEN RAISE EXCEPTION 'CALENDAR_SYNC_MAPPING_INVALID' USING ERRCODE = '23514'; END IF;
  IF TG_TABLE_NAME = 'integration_calendar_credentials' THEN
   IF connection.provider <> NEW.provider OR connection.provider = 'ICS' THEN RAISE EXCEPTION 'CALENDAR_SYNC_MAPPING_INVALID' USING ERRCODE = '23514'; END IF;
   IF TG_OP = 'UPDATE' AND (OLD.provider <> NEW.provider OR OLD.credential_ref <> NEW.credential_ref OR OLD.created_at <> NEW.created_at OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)) THEN
    RAISE EXCEPTION 'CALENDAR_SYNC_HISTORY_IMMUTABLE' USING ERRCODE = '23514';
   END IF;
  ELSIF TG_TABLE_NAME = 'calendar_sync_mappings' THEN
   IF NEW.external_calendar_id <> connection.external_calendar_id OR NOT EXISTS (SELECT 1 FROM calendar_events WHERE id = NEW.local_event_id AND workspace_id = NEW.workspace_id AND calendar_id = connection.calendar_id) THEN
    RAISE EXCEPTION 'CALENDAR_SYNC_MAPPING_INVALID' USING ERRCODE = '23514';
   END IF;
   IF TG_OP = 'UPDATE' AND (OLD.local_event_id <> NEW.local_event_id OR OLD.external_calendar_id <> NEW.external_calendar_id) THEN RAISE EXCEPTION 'CALENDAR_SYNC_MAPPING_INVALID' USING ERRCODE = '23514'; END IF;
  ELSIF TG_TABLE_NAME = 'calendar_sync_conflicts' THEN
   IF TG_OP = 'UPDATE' AND (OLD.mapping_id <> NEW.mapping_id OR OLD.local_event_id <> NEW.local_event_id OR OLD.status = 'RESOLVED') THEN
    RAISE EXCEPTION 'CALENDAR_SYNC_HISTORY_IMMUTABLE' USING ERRCODE = '23514';
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE tab TEXT; BEGIN
 FOREACH tab IN ARRAY ARRAY['calendar_sync_connections','integration_calendar_credentials','calendar_sync_mappings','calendar_sync_conflicts'] LOOP
  EXECUTE format('CREATE TRIGGER calendar_sync_revision BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION calendar_booking_source_epoch()',tab);
 END LOOP;
END $$;
