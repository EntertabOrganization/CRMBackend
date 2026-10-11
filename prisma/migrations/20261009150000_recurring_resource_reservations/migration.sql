ALTER TABLE calendar_resource_bookings
  ADD COLUMN recurrence_id TEXT NOT NULL DEFAULT 'SINGLE',
  ADD COLUMN series_booking_id UUID,
  ADD CONSTRAINT calendar_resource_booking_workspace_id UNIQUE(workspace_id, id);
ALTER TABLE calendar_resource_bookings DROP CONSTRAINT calendar_resource_bookings_resource_id_event_id_key;
ALTER TABLE calendar_resource_bookings ADD CONSTRAINT calendar_resource_booking_occurrence UNIQUE(resource_id, event_id, recurrence_id);
ALTER TABLE calendar_resource_bookings ADD CONSTRAINT calendar_resource_booking_series
  FOREIGN KEY(workspace_id, series_booking_id) REFERENCES calendar_resource_bookings(workspace_id, id) ON DELETE NO ACTION;
ALTER TABLE calendar_resource_bookings ADD CONSTRAINT calendar_resource_booking_identity CHECK (
  (series_booking_id IS NULL AND recurrence_id IN ('SINGLE', '__SERIES__')) OR
  (series_booking_id IS NOT NULL AND recurrence_id NOT IN ('SINGLE', '__SERIES__') AND length(recurrence_id) BETWEEN 10 AND 23));
ALTER TABLE calendar_resource_bookings DROP CONSTRAINT calendar_resource_booking_exclusive;
ALTER TABLE calendar_resource_bookings ADD CONSTRAINT calendar_resource_booking_exclusive
  EXCLUDE USING gist (workspace_id WITH =, resource_id WITH =, tstzrange(start_at, end_at, '[)') WITH &&)
  WHERE (exclusive AND status = 'ACTIVE' AND recurrence_id <> '__SERIES__') DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION calendar_resource_booking_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE resource calendar_resources%ROWTYPE; event calendar_events%ROWTYPE; parent calendar_resource_bookings%ROWTYPE; party INTEGER;
BEGIN
  IF TG_OP = 'UPDATE' AND (OLD.workspace_id <> NEW.workspace_id OR OLD.resource_id <> NEW.resource_id OR OLD.event_id <> NEW.event_id OR
    OLD.series_booking_id IS DISTINCT FROM NEW.series_booking_id OR (OLD.series_booking_id IS NOT NULL AND OLD.recurrence_id <> NEW.recurrence_id)) THEN
    RAISE EXCEPTION 'RESOURCE_NOT_FOUND' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO event FROM calendar_events WHERE id = NEW.event_id AND workspace_id = NEW.workspace_id FOR SHARE;
  SELECT * INTO resource FROM calendar_resources WHERE id = NEW.resource_id AND workspace_id = NEW.workspace_id FOR UPDATE;
  IF resource.id IS NULL OR event.id IS NULL THEN RETURN NEW; END IF;
  IF NEW.series_booking_id IS NOT NULL THEN
    SELECT * INTO parent FROM calendar_resource_bookings WHERE id = NEW.series_booking_id AND workspace_id = NEW.workspace_id;
    IF parent.id IS NOT NULL AND (parent.series_booking_id IS NOT NULL OR parent.resource_id <> NEW.resource_id OR parent.event_id <> NEW.event_id) THEN
      RAISE EXCEPTION 'RESOURCE_NOT_FOUND' USING ERRCODE = '23514';
    END IF;
  ELSE
    NEW.recurrence_id := CASE WHEN event.recurrence_rule_id IS NULL THEN 'SINGLE' ELSE '__SERIES__' END;
  END IF;
  IF NEW.status = 'ACTIVE' THEN
    IF NOT resource.is_active OR resource.is_deleted THEN RAISE EXCEPTION 'RESOURCE_INACTIVE' USING ERRCODE = '23514'; END IF;
    IF event.is_deleted OR event.status = 'CANCELLED' THEN RAISE EXCEPTION 'EVENT_CANCELLED' USING ERRCODE = '23514'; END IF;
    IF event.recurrence_parent_event_id IS NOT NULL OR (NEW.series_booking_id IS NOT NULL AND
      (event.recurrence_rule_id IS NULL OR parent.status IS DISTINCT FROM 'ACTIVE')) THEN
      RAISE EXCEPTION 'RECURRENCE_SCOPE_INVALID' USING ERRCODE = '23514';
    END IF;
    SELECT count(*) INTO party FROM (SELECT event.organizer_user_id AS id UNION SELECT user_id FROM calendar_event_attendees
      WHERE event_id = event.id AND removed_at IS NULL AND response <> 'DECLINED') people;
    SELECT party + count(*) INTO party FROM calendar_external_guests WHERE event_id = event.id AND removed_at IS NULL AND response <> 'DECLINED';
    IF resource.capacity IS NOT NULL AND party > resource.capacity THEN RAISE EXCEPTION 'RESOURCE_CAPACITY_INVALID' USING ERRCODE = '23514'; END IF;
    NEW.exclusive := resource.is_exclusive;
    IF NEW.series_booking_id IS NULL THEN
      NEW.start_at := CASE WHEN event.is_all_day THEN event.start_date::timestamp AT TIME ZONE event.source_timezone ELSE event.start_at END;
      NEW.end_at := CASE WHEN event.is_all_day THEN event.end_date::timestamp AT TIME ZONE event.source_timezone ELSE event.end_at END;
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION calendar_resource_refresh() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'calendar_resources' THEN
    UPDATE calendar_resource_bookings SET exclusive = NEW.is_exclusive,
      status = CASE WHEN NOT NEW.is_active OR NEW.is_deleted THEN 'CANCELLED' ELSE status END, updated_at = NEW.updated_at
      WHERE resource_id = NEW.id AND status = 'ACTIVE';
  ELSE
    UPDATE calendar_resource_bookings SET status = CASE WHEN NEW.is_deleted OR NEW.status = 'CANCELLED' OR
      (NEW.recurrence_rule_id IS NULL AND series_booking_id IS NOT NULL) THEN 'CANCELLED' ELSE status END,
      updated_at = NEW.updated_at WHERE event_id = NEW.id AND status = 'ACTIVE';
  END IF;
  RETURN NEW;
END $$;
