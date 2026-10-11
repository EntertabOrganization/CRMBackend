ALTER TABLE calendar_bookings ADD COLUMN public_receipt_revoked BOOLEAN NOT NULL DEFAULT false;

CREATE FUNCTION calendar_booking_contact_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    OLD.public_receipt_revoked AND NOT NEW.public_receipt_revoked OR
    OLD.guest_email <> NEW.guest_email AND (
      NOT NEW.public_receipt_revoked OR NEW.token_generation <> OLD.token_generation + 1 OR
      NEW.cancellation_token_hash IS NOT DISTINCT FROM OLD.cancellation_token_hash OR
      NEW.reschedule_token_hash IS NOT DISTINCT FROM OLD.reschedule_token_hash)) THEN
    RAISE EXCEPTION 'BOOKING_STATE_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER calendar_booking_contact_guard BEFORE UPDATE ON calendar_bookings
  FOR EACH ROW EXECUTE FUNCTION calendar_booking_contact_guard();

-- Contacts on confirmed Reservations and their Calendar guest commit as one graph.
CREATE FUNCTION calendar_booking_guest_contact_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event UUID; scope UUID;
BEGIN
  IF TG_TABLE_NAME = 'calendar_bookings' THEN
    event := NEW.event_id; scope := NEW.workspace_id;
    IF OLD.guest_email = NEW.guest_email AND OLD.guest_name = NEW.guest_name THEN RETURN NULL; END IF;
  ELSE
    event := OLD.event_id; scope := OLD.workspace_id;
  END IF;
  IF EXISTS(SELECT 1 FROM calendar_bookings b WHERE b.workspace_id = scope AND b.event_id = event AND b.status = 'CONFIRMED'
    AND NOT EXISTS(SELECT 1 FROM calendar_external_guests g WHERE g.workspace_id = b.workspace_id AND g.event_id = b.event_id
      AND g.email = b.guest_email AND g.name = b.guest_name AND g.removed_at IS NULL)) THEN
    RAISE EXCEPTION 'BOOKING_EVENT_MANAGED' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER calendar_booking_guest_contact_guard AFTER UPDATE ON calendar_bookings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION calendar_booking_guest_contact_guard();
CREATE CONSTRAINT TRIGGER calendar_external_guest_booking_contact_guard AFTER UPDATE OR DELETE ON calendar_external_guests
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION calendar_booking_guest_contact_guard();

DO $$ DECLARE constraint_name TEXT; BEGIN
  FOR constraint_name IN SELECT conname FROM pg_constraint
    WHERE conrelid = 'calendar_booking_notification_deliveries'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%notification_type%' LOOP
    EXECUTE format('ALTER TABLE calendar_booking_notification_deliveries DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;
ALTER TABLE calendar_booking_notification_deliveries ADD CONSTRAINT booking_notification_type_allowed
  CHECK(notification_type IN ('BOOKING_CREATED','BOOKING_CONFIRMED','BOOKING_RESCHEDULED','BOOKING_CANCELLED','BOOKING_REJECTED','BOOKING_UPDATED'));
