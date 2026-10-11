CREATE TABLE calendar_resources (
  id UUID PRIMARY KEY, workspace_id UUID NOT NULL, created_by_user_id UUID NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('ROOM', 'EQUIPMENT', 'OTHER')),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 500), description TEXT,
  capacity INTEGER CHECK (capacity BETWEEN 1 AND 1000000), timezone TEXT NOT NULL,
  is_exclusive BOOLEAN NOT NULL DEFAULT true, is_active BOOLEAN NOT NULL DEFAULT true,
  is_deleted BOOLEAN NOT NULL DEFAULT false, version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ(6) NOT NULL, updated_at TIMESTAMPTZ(6) NOT NULL,
  UNIQUE(workspace_id, id),
  FOREIGN KEY(workspace_id, created_by_user_id) REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE NO ACTION
);
CREATE TABLE calendar_resource_bookings (
  id UUID PRIMARY KEY, workspace_id UUID NOT NULL, resource_id UUID NOT NULL, event_id UUID NOT NULL,
  start_at TIMESTAMPTZ(6) NOT NULL, end_at TIMESTAMPTZ(6) NOT NULL CHECK(end_at > start_at),
  exclusive BOOLEAN NOT NULL, status TEXT NOT NULL CHECK(status IN ('ACTIVE', 'CANCELLED')),
  created_at TIMESTAMPTZ(6) NOT NULL, updated_at TIMESTAMPTZ(6) NOT NULL,
  UNIQUE(resource_id, event_id),
  FOREIGN KEY(workspace_id, resource_id) REFERENCES calendar_resources(workspace_id, id) ON DELETE NO ACTION,
  FOREIGN KEY(workspace_id, event_id) REFERENCES calendar_events(workspace_id, id) ON DELETE NO ACTION
);
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE calendar_resource_bookings ADD CONSTRAINT calendar_resource_booking_exclusive
  EXCLUDE USING gist (workspace_id WITH =, resource_id WITH =, tstzrange(start_at, end_at, '[)') WITH &&)
  WHERE (exclusive AND status = 'ACTIVE');
CREATE INDEX calendar_resources_workspace ON calendar_resources(workspace_id, is_deleted, is_active);
CREATE INDEX calendar_resource_bookings_event ON calendar_resource_bookings(workspace_id, event_id, status);

CREATE FUNCTION calendar_resource_booking_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE resource calendar_resources%ROWTYPE; event calendar_events%ROWTYPE; party INTEGER;
BEGIN
  IF TG_OP = 'UPDATE' AND (OLD.workspace_id <> NEW.workspace_id OR OLD.resource_id <> NEW.resource_id OR OLD.event_id <> NEW.event_id) THEN
    RAISE EXCEPTION 'RESOURCE_NOT_FOUND' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO resource FROM calendar_resources WHERE id = NEW.resource_id AND workspace_id = NEW.workspace_id FOR UPDATE;
  SELECT * INTO event FROM calendar_events WHERE id = NEW.event_id AND workspace_id = NEW.workspace_id;
  IF resource.id IS NULL OR event.id IS NULL THEN RETURN NEW; END IF; -- Composite FKs report tenant violations.
  IF NEW.status = 'ACTIVE' THEN
    IF NOT resource.is_active OR resource.is_deleted THEN RAISE EXCEPTION 'RESOURCE_INACTIVE' USING ERRCODE = '23514'; END IF;
    IF event.is_deleted OR event.status = 'CANCELLED' THEN RAISE EXCEPTION 'EVENT_CANCELLED' USING ERRCODE = '23514'; END IF;
    IF event.recurrence_rule_id IS NOT NULL OR event.recurrence_parent_event_id IS NOT NULL THEN
      RAISE EXCEPTION 'RECURRENCE_SCOPE_INVALID' USING ERRCODE = '23514';
    END IF;
    SELECT count(*) INTO party FROM (SELECT event.organizer_user_id AS id UNION SELECT user_id FROM calendar_event_attendees
      WHERE event_id = event.id AND removed_at IS NULL AND response <> 'DECLINED') people;
    SELECT party + count(*) INTO party FROM calendar_external_guests WHERE event_id = event.id AND removed_at IS NULL AND response <> 'DECLINED';
    IF resource.capacity IS NOT NULL AND party > resource.capacity THEN RAISE EXCEPTION 'RESOURCE_CAPACITY_INVALID' USING ERRCODE = '23514'; END IF;
    NEW.exclusive := resource.is_exclusive;
    NEW.start_at := CASE WHEN event.is_all_day THEN event.start_date::timestamp AT TIME ZONE event.source_timezone ELSE event.start_at END;
    NEW.end_at := CASE WHEN event.is_all_day THEN event.end_date::timestamp AT TIME ZONE event.source_timezone ELSE event.end_at END;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER calendar_resource_booking_guard BEFORE INSERT OR UPDATE ON calendar_resource_bookings
  FOR EACH ROW EXECUTE FUNCTION calendar_resource_booking_guard();

CREATE FUNCTION calendar_resource_config_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.workspace_id <> NEW.workspace_id OR OLD.created_by_user_id <> NEW.created_by_user_id THEN
    RAISE EXCEPTION 'RESOURCE_NOT_FOUND' USING ERRCODE = '23514';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN RAISE EXCEPTION 'RESOURCE_VERSION_CONFLICT' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER calendar_resource_config_guard BEFORE UPDATE ON calendar_resources FOR EACH ROW EXECUTE FUNCTION calendar_resource_config_guard();
CREATE FUNCTION calendar_resource_refresh() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'calendar_resources' THEN
    UPDATE calendar_resource_bookings SET exclusive = NEW.is_exclusive,
      status = CASE WHEN NOT NEW.is_active OR NEW.is_deleted THEN 'CANCELLED' ELSE status END, updated_at = NEW.updated_at
      WHERE resource_id = NEW.id AND status = 'ACTIVE';
  ELSE
    UPDATE calendar_resource_bookings SET status = CASE WHEN NEW.is_deleted OR NEW.status = 'CANCELLED' THEN 'CANCELLED' ELSE status END,
      updated_at = NEW.updated_at WHERE event_id = NEW.id AND status = 'ACTIVE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER calendar_resource_refresh AFTER UPDATE ON calendar_resources FOR EACH ROW EXECUTE FUNCTION calendar_resource_refresh();
CREATE TRIGGER calendar_event_resource_refresh AFTER UPDATE ON calendar_events FOR EACH ROW EXECUTE FUNCTION calendar_resource_refresh();
CREATE FUNCTION calendar_resource_party_refresh() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE calendar_resource_bookings SET updated_at = clock_timestamp() WHERE event_id = NEW.event_id AND status = 'ACTIVE';
  RETURN NEW;
END $$;
CREATE TRIGGER calendar_resource_attendee_refresh AFTER INSERT OR UPDATE ON calendar_event_attendees FOR EACH ROW EXECUTE FUNCTION calendar_resource_party_refresh();
CREATE TRIGGER calendar_resource_guest_refresh AFTER INSERT OR UPDATE ON calendar_external_guests FOR EACH ROW EXECUTE FUNCTION calendar_resource_party_refresh();
