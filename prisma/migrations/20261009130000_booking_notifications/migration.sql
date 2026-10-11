ALTER TABLE calendar_bookings ADD CONSTRAINT calendar_bookings_workspace_id_id_key UNIQUE(workspace_id,id);
CREATE TABLE calendar_booking_notification_events (
  event_id UUID PRIMARY KEY REFERENCES outbox_events(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE calendar_booking_notification_deliveries (
  id UUID PRIMARY KEY, workspace_id UUID NOT NULL,
  booking_id UUID NOT NULL, event_id UUID NOT NULL REFERENCES outbox_events(id) ON DELETE RESTRICT,
  source_version INTEGER NOT NULL CHECK (source_version > 0),
  notification_type TEXT NOT NULL CHECK (notification_type IN ('BOOKING_CREATED','BOOKING_CONFIRMED','BOOKING_RESCHEDULED','BOOKING_CANCELLED','BOOKING_REJECTED')),
  recipient_key TEXT NOT NULL, recipient_user_id UUID, guest_email TEXT,
  status TEXT NOT NULL CHECK (status IN ('SCHEDULED','SENT','SUPPRESSED','FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 5),
  next_attempt_at TIMESTAMPTZ(6), claim_token UUID, lease_expires_at TIMESTAMPTZ(6), last_error_code TEXT,
  sent_at TIMESTAMPTZ(6), created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(event_id, recipient_key),
  CHECK ((recipient_user_id IS NOT NULL AND guest_email IS NULL AND recipient_key = recipient_user_id::text)
    OR (recipient_user_id IS NULL AND guest_email IS NOT NULL AND recipient_key = 'GUEST')),
  CHECK ((claim_token IS NULL) = (lease_expires_at IS NULL)),
  FOREIGN KEY(workspace_id, booking_id) REFERENCES calendar_bookings(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id, recipient_user_id) REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE RESTRICT
);
CREATE INDEX calendar_booking_notification_deliveries_status_next_attempt_at_idx ON calendar_booking_notification_deliveries(status,next_attempt_at);
CREATE INDEX calendar_booking_notifications_outbox ON outbox_events(occurred_at,id) WHERE entity_type = 'CALENDAR_BOOKING';
CREATE FUNCTION calendar_booking_notification_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM outbox_events WHERE id = NEW.event_id AND workspace_id = NEW.workspace_id
    AND entity_id = NEW.booking_id AND entity_type = 'CALENDAR_BOOKING' AND event_type = NEW.notification_type
    AND (payload->>'version')::integer = NEW.source_version) THEN
    RAISE EXCEPTION 'BOOKING_NOTIFICATION_SOURCE_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER calendar_booking_notification_source_guard BEFORE INSERT OR UPDATE ON calendar_booking_notification_deliveries
  FOR EACH ROW EXECUTE FUNCTION calendar_booking_notification_source_guard();
