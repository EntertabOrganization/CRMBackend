-- External calendar sync: connections, integration-owned credential references, stable mappings and explicit conflicts.
CREATE TABLE calendar_sync_connections (
 id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT, user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 calendar_id UUID NOT NULL, provider TEXT NOT NULL CHECK(provider IN ('GOOGLE','MICROSOFT','ICS')), name TEXT NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 200),
 external_calendar_id TEXT NOT NULL CHECK(length(external_calendar_id) BETWEEN 1 AND 500), account_email TEXT CHECK(account_email IS NULL OR length(account_email) <= 320),
 status TEXT NOT NULL CHECK(status IN ('ACTIVE','AUTH_REQUIRED','DISCONNECTED')), sync_cursor TEXT CHECK(sync_cursor IS NULL OR length(sync_cursor) <= 2000),
 last_synced_at TIMESTAMPTZ, last_error TEXT CHECK(last_error IS NULL OR length(last_error) <= 100), failure_count INTEGER NOT NULL CHECK(failure_count >= 0),
 claim_id UUID, lease_expires_at TIMESTAMPTZ, version INTEGER NOT NULL CHECK(version > 0), created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
 UNIQUE(workspace_id, id), FOREIGN KEY(workspace_id, calendar_id) REFERENCES calendars(workspace_id, id) ON DELETE RESTRICT,
 CHECK((claim_id IS NULL) = (lease_expires_at IS NULL)), CHECK(status <> 'DISCONNECTED' OR claim_id IS NULL),
 CHECK(provider <> 'ICS' OR external_calendar_id LIKE 'ics:%')
);
CREATE UNIQUE INDEX calendar_sync_ics_source ON calendar_sync_connections(workspace_id, user_id, calendar_id, external_calendar_id) WHERE provider = 'ICS' AND status <> 'DISCONNECTED';
-- Opaque broker references only (the broker holds OAuth tokens); they are never projected by Calendar APIs.
CREATE TABLE integration_calendar_credentials (
 id UUID PRIMARY KEY, workspace_id UUID NOT NULL, connection_id UUID NOT NULL, provider TEXT NOT NULL CHECK(provider IN ('GOOGLE','MICROSOFT')),
 credential_ref TEXT NOT NULL CHECK(length(credential_ref) BETWEEN 1 AND 500), created_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ,
 FOREIGN KEY(workspace_id, connection_id) REFERENCES calendar_sync_connections(workspace_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX integration_calendar_credentials_active ON integration_calendar_credentials(connection_id) WHERE revoked_at IS NULL;
CREATE TABLE calendar_sync_mappings (
 id UUID PRIMARY KEY, workspace_id UUID NOT NULL, connection_id UUID NOT NULL, local_event_id UUID NOT NULL,
 external_calendar_id TEXT NOT NULL CHECK(length(external_calendar_id) BETWEEN 1 AND 500), external_event_id TEXT NOT NULL CHECK(length(external_event_id) BETWEEN 1 AND 500),
 external_version TEXT CHECK(external_version IS NULL OR length(external_version) <= 500), local_version_at_last_sync INTEGER NOT NULL CHECK(local_version_at_last_sync >= -1),
 last_direction TEXT NOT NULL CHECK(last_direction IN ('INBOUND','OUTBOUND')), last_synced_at TIMESTAMPTZ NOT NULL, version INTEGER NOT NULL CHECK(version > 0),
 created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
 UNIQUE(connection_id, external_calendar_id, external_event_id), UNIQUE(connection_id, local_event_id), UNIQUE(workspace_id, connection_id, id),
 FOREIGN KEY(workspace_id, connection_id) REFERENCES calendar_sync_connections(workspace_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(workspace_id, local_event_id) REFERENCES calendar_events(workspace_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE calendar_sync_conflicts (
 id UUID PRIMARY KEY, workspace_id UUID NOT NULL, connection_id UUID NOT NULL, mapping_id UUID NOT NULL, local_event_id UUID NOT NULL,
 local_snapshot_json JSONB NOT NULL CHECK(jsonb_typeof(local_snapshot_json) = 'object'), external_snapshot_json JSONB NOT NULL CHECK(jsonb_typeof(external_snapshot_json) = 'object'),
 external_version TEXT NOT NULL, local_version INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('OPEN','RESOLVED')),
 resolution TEXT CHECK(resolution IS NULL OR resolution IN ('LOCAL','EXTERNAL','MERGED','IGNORED')), resolved_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
 resolved_at TIMESTAMPTZ, version INTEGER NOT NULL CHECK(version > 0), created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
 FOREIGN KEY(workspace_id, connection_id, mapping_id) REFERENCES calendar_sync_mappings(workspace_id, connection_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 CHECK((status = 'RESOLVED') = (resolution IS NOT NULL) AND (status = 'RESOLVED') = (resolved_by_user_id IS NOT NULL) AND (status = 'RESOLVED') = (resolved_at IS NOT NULL))
);
-- At most one open conflict per mapping: it stays visible until resolved.
CREATE UNIQUE INDEX calendar_sync_conflicts_open ON calendar_sync_conflicts(mapping_id) WHERE status = 'OPEN';

CREATE FUNCTION calendar_sync_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row JSONB; old_row JSONB; existing BOOLEAN; connection calendar_sync_connections%ROWTYPE;
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'CALENDAR_SYNC_MAPPING_INVALID' USING ERRCODE='23514'; END IF;
 row := to_jsonb(NEW);
 IF TG_OP = 'UPDATE' THEN
  old_row := to_jsonb(OLD);
  IF row->>'workspace_id' <> old_row->>'workspace_id' OR row->>'created_at' IS DISTINCT FROM old_row->>'created_at'
    OR row->>'connection_id' IS DISTINCT FROM old_row->>'connection_id' OR row->>'user_id' IS DISTINCT FROM old_row->>'user_id'
    OR row->>'calendar_id' IS DISTINCT FROM old_row->>'calendar_id' OR row->>'provider' IS DISTINCT FROM old_row->>'provider'
    OR row->>'local_event_id' IS DISTINCT FROM old_row->>'local_event_id' OR row->>'mapping_id' IS DISTINCT FROM old_row->>'mapping_id'
    OR TG_TABLE_NAME = 'calendar_sync_mappings' AND (row->>'external_calendar_id' <> old_row->>'external_calendar_id')
    OR TG_TABLE_NAME = 'integration_calendar_credentials' AND (row->>'credential_ref' <> old_row->>'credential_ref' OR old_row->>'revoked_at' IS NOT NULL AND row IS DISTINCT FROM old_row)
    OR TG_TABLE_NAME = 'calendar_sync_conflicts' AND old_row->>'status' = 'RESOLVED' AND row IS DISTINCT FROM old_row
    OR TG_TABLE_NAME = 'calendar_sync_connections' AND old_row->>'status' = 'DISCONNECTED' AND row->>'status' <> 'DISCONNECTED'
    OR (row->>'version') IS NOT NULL AND (row->>'version')::int < (old_row->>'version')::int THEN
   RAISE EXCEPTION 'CALENDAR_SYNC_MAPPING_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I WHERE id = $1)', TG_TABLE_NAME) INTO existing USING (row->>'id')::uuid;
 IF existing THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME = 'calendar_sync_connections' THEN
  IF NOT EXISTS(SELECT 1 FROM workspace_memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = (row->>'workspace_id')::uuid AND m.user_id = (row->>'user_id')::uuid
    AND m.status = 'ACTIVE' AND NOT m.is_deleted AND NOT u.is_deleted) THEN RAISE EXCEPTION 'CALENDAR_SYNC_MAPPING_INVALID' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO connection FROM calendar_sync_connections WHERE id = (row->>'connection_id')::uuid AND workspace_id = (row->>'workspace_id')::uuid;
 IF NOT FOUND OR connection.status = 'DISCONNECTED' THEN RAISE EXCEPTION 'CALENDAR_SYNC_CONNECTION_NOT_FOUND' USING ERRCODE='23514'; END IF;
 -- Mappings bind Events of the connection's own Calendar and that connection's external calendar namespace.
 IF TG_TABLE_NAME = 'calendar_sync_mappings' AND (NOT EXISTS(SELECT 1 FROM calendar_events e WHERE e.id = (row->>'local_event_id')::uuid AND e.calendar_id = connection.calendar_id)
   OR row->>'external_calendar_id' <> connection.external_calendar_id) THEN
  RAISE EXCEPTION 'CALENDAR_SYNC_MAPPING_INVALID' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE tab TEXT; BEGIN
 FOREACH tab IN ARRAY ARRAY['calendar_sync_connections','integration_calendar_credentials','calendar_sync_mappings','calendar_sync_conflicts'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION calendar_sync_guard()', tab || '_guard', tab);
 END LOOP;
END $$;
