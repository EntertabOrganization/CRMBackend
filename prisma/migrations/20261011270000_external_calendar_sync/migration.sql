-- Provider credentials remain in the Integration broker; this table stores opaque references only.
CREATE TABLE calendar_sync_connections (
 id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, calendar_id UUID NOT NULL,
 provider TEXT NOT NULL CHECK(provider IN ('GOOGLE','MICROSOFT','ICS')), name TEXT NOT NULL,
 external_calendar_id TEXT NOT NULL, account_email TEXT, status TEXT NOT NULL CHECK(status IN ('ACTIVE','AUTH_REQUIRED','DISCONNECTED')),
 sync_cursor TEXT, last_synced_at TIMESTAMPTZ, last_error TEXT, failure_count INTEGER NOT NULL CHECK(failure_count >= 0),
 claim_id UUID, lease_expires_at TIMESTAMPTZ, version INTEGER NOT NULL CHECK(version > 0), created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
 UNIQUE(workspace_id, id), CHECK((claim_id IS NULL) = (lease_expires_at IS NULL)),
 CHECK(status = 'ACTIVE' OR claim_id IS NULL),
 FOREIGN KEY(workspace_id, calendar_id) REFERENCES calendars(workspace_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX calendar_sync_connections_owner ON calendar_sync_connections(workspace_id, user_id, status);
CREATE TABLE integration_calendar_credentials (
 id UUID PRIMARY KEY, workspace_id UUID NOT NULL, connection_id UUID NOT NULL, provider TEXT NOT NULL CHECK(provider IN ('GOOGLE','MICROSOFT')),
 credential_ref TEXT NOT NULL CHECK(length(credential_ref) BETWEEN 1 AND 500), created_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ,
 FOREIGN KEY(workspace_id, connection_id) REFERENCES calendar_sync_connections(workspace_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX integration_calendar_credentials_live ON integration_calendar_credentials(connection_id) WHERE revoked_at IS NULL;
CREATE TABLE calendar_sync_mappings (
 id UUID PRIMARY KEY, workspace_id UUID NOT NULL, connection_id UUID NOT NULL, local_event_id UUID NOT NULL,
 external_calendar_id TEXT NOT NULL, external_event_id TEXT NOT NULL, external_version TEXT,
 local_version_at_last_sync INTEGER NOT NULL CHECK(local_version_at_last_sync >= -1), last_direction TEXT NOT NULL CHECK(last_direction IN ('INBOUND','OUTBOUND')),
 last_synced_at TIMESTAMPTZ NOT NULL, version INTEGER NOT NULL CHECK(version > 0), created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
 UNIQUE(connection_id, external_calendar_id, external_event_id), UNIQUE(connection_id, local_event_id), UNIQUE(workspace_id, connection_id, id, local_event_id),
 FOREIGN KEY(workspace_id, connection_id) REFERENCES calendar_sync_connections(workspace_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(workspace_id, local_event_id) REFERENCES calendar_events(workspace_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE calendar_sync_conflicts (
 id UUID PRIMARY KEY, workspace_id UUID NOT NULL, connection_id UUID NOT NULL, mapping_id UUID NOT NULL, local_event_id UUID NOT NULL,
 local_snapshot_json JSONB NOT NULL, external_snapshot_json JSONB NOT NULL, external_version TEXT NOT NULL, local_version INTEGER NOT NULL CHECK(local_version > 0),
 status TEXT NOT NULL CHECK(status IN ('OPEN','RESOLVED')), resolution TEXT CHECK(resolution IN ('LOCAL','EXTERNAL','MERGED','IGNORED')),
 resolved_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT, resolved_at TIMESTAMPTZ,
 version INTEGER NOT NULL CHECK(version > 0), created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
 CHECK((status = 'RESOLVED') = (resolution IS NOT NULL) AND (status = 'RESOLVED') = (resolved_by_user_id IS NOT NULL) AND (status = 'RESOLVED') = (resolved_at IS NOT NULL)),
 FOREIGN KEY(workspace_id, connection_id, mapping_id, local_event_id) REFERENCES calendar_sync_mappings(workspace_id, connection_id, id, local_event_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX calendar_sync_conflicts_open ON calendar_sync_conflicts(mapping_id) WHERE status = 'OPEN';
CREATE INDEX calendar_sync_conflicts_workspace ON calendar_sync_conflicts(workspace_id, status, created_at);

CREATE FUNCTION calendar_sync_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
  EXECUTE format('CREATE TRIGGER calendar_sync_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION calendar_sync_guard()',tab);
  EXECUTE format('CREATE TRIGGER calendar_sync_revision BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION calendar_booking_source_epoch()',tab);
 END LOOP;
END $$;
