-- Preserve the existing Event range constraint/error before evaluating reservation overlaps.
CREATE OR REPLACE FUNCTION calendar_booking_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_start TIMESTAMPTZ; event_end TIMESTAMPTZ;
BEGIN
  PERFORM calendar_booking_lock_workspace(NEW.workspace_id);
  IF NOT NEW.is_deleted AND NEW.status <> 'CANCELLED' AND NEW.busy_status = 'BUSY' AND NEW.recurrence_rule_id IS NULL AND NEW.recurrence_parent_event_id IS NULL THEN
    event_start := CASE WHEN NEW.is_all_day THEN NEW.start_date::timestamp AT TIME ZONE NEW.source_timezone ELSE NEW.start_at END;
    event_end := CASE WHEN NEW.is_all_day THEN NEW.end_date::timestamp AT TIME ZONE NEW.source_timezone ELSE NEW.end_at END;
    IF event_start IS NULL OR event_end IS NULL OR event_end <= event_start THEN RETURN NEW; END IF;
    IF EXISTS(SELECT 1 FROM calendar_bookings b WHERE b.workspace_id = NEW.workspace_id AND b.event_id IS DISTINCT FROM NEW.id AND b.status IN ('PENDING', 'CONFIRMED')
      AND (b.owner_user_id = NEW.organizer_user_id OR EXISTS(SELECT 1 FROM calendar_event_attendees a WHERE a.event_id = NEW.id AND a.user_id = b.owner_user_id AND a.removed_at IS NULL AND a.response <> 'DECLINED'))
      AND tstzrange(event_start, event_end, '[)') && tstzrange(b.reserved_start_at, b.reserved_end_at, '[)')) THEN
      RAISE EXCEPTION 'BOOKING_SLOT_UNAVAILABLE' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
