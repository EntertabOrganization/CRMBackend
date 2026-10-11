CREATE OR REPLACE FUNCTION calendar_resource_booking_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE resource calendar_resources%ROWTYPE; event calendar_events%ROWTYPE; party INTEGER;
BEGIN
  IF TG_OP = 'UPDATE' AND (OLD.workspace_id <> NEW.workspace_id OR OLD.resource_id <> NEW.resource_id OR OLD.event_id <> NEW.event_id) THEN
    RAISE EXCEPTION 'RESOURCE_NOT_FOUND' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO event FROM calendar_events WHERE id = NEW.event_id AND workspace_id = NEW.workspace_id FOR SHARE;
  SELECT * INTO resource FROM calendar_resources WHERE id = NEW.resource_id AND workspace_id = NEW.workspace_id FOR UPDATE;
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
