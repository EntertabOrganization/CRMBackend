CREATE FUNCTION calendar_booking_attendee_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event calendar_events%ROWTYPE;
BEGIN
  PERFORM calendar_booking_lock_workspace(NEW.workspace_id);
  IF NEW.removed_at IS NULL AND NEW.response <> 'DECLINED' THEN
    SELECT * INTO event FROM calendar_events WHERE id = NEW.event_id AND workspace_id = NEW.workspace_id;
    IF NOT event.is_deleted AND event.status <> 'CANCELLED' AND event.busy_status = 'BUSY' AND event.recurrence_rule_id IS NULL AND event.recurrence_parent_event_id IS NULL AND
      EXISTS(SELECT 1 FROM calendar_bookings b WHERE b.workspace_id = NEW.workspace_id AND b.owner_user_id = NEW.user_id
        AND b.event_id IS DISTINCT FROM NEW.event_id AND b.status IN ('PENDING', 'CONFIRMED')
        AND tstzrange(CASE WHEN event.is_all_day THEN event.start_date::timestamp AT TIME ZONE event.source_timezone ELSE event.start_at END,
          CASE WHEN event.is_all_day THEN event.end_date::timestamp AT TIME ZONE event.source_timezone ELSE event.end_at END, '[)') && tstzrange(b.reserved_start_at, b.reserved_end_at, '[)')) THEN
      RAISE EXCEPTION 'BOOKING_SLOT_UNAVAILABLE' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER calendar_booking_attendee_guard BEFORE INSERT OR UPDATE ON calendar_event_attendees FOR EACH ROW EXECUTE FUNCTION calendar_booking_attendee_guard();
