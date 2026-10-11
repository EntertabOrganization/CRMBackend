CREATE FUNCTION calendar_booking_required_rules_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE must_validate BOOLEAN;
BEGIN
  must_validate := TG_OP = 'INSERT';
  IF TG_OP = 'UPDATE' THEN
    IF OLD.id <> NEW.id THEN RAISE EXCEPTION 'BOOKING_STATE_INVALID' USING ERRCODE = '23514'; END IF;
    must_validate := OLD.status IS DISTINCT FROM NEW.status OR OLD.start_at <> NEW.start_at OR OLD.end_at <> NEW.end_at OR
      OLD.reserved_start_at <> NEW.reserved_start_at OR OLD.reserved_end_at <> NEW.reserved_end_at;
  END IF;
  IF must_validate AND NEW.status IN ('PENDING', 'CONFIRMED') AND
    EXISTS(SELECT 1 FROM calendar_booking_pages WHERE id = NEW.booking_page_id AND workspace_id = NEW.workspace_id) AND
    NOT EXISTS(SELECT 1 FROM calendar_availability_rules WHERE page_id = NEW.booking_page_id AND workspace_id = NEW.workspace_id) THEN
    RAISE EXCEPTION 'BOOKING_SLOT_UNAVAILABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER calendar_booking_required_rules_guard BEFORE INSERT OR UPDATE ON calendar_bookings
  FOR EACH ROW EXECUTE FUNCTION calendar_booking_required_rules_guard();
