ALTER TABLE calendar_booking_pages ADD COLUMN attendee_user_ids UUID[] NOT NULL DEFAULT '{}', ADD COLUMN resource_ids UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE calendar_bookings ADD COLUMN attendee_user_ids UUID[] NOT NULL DEFAULT '{}', ADD COLUMN resource_ids UUID[] NOT NULL DEFAULT '{}';

CREATE FUNCTION calendar_booking_user_ids(booking calendar_bookings) RETURNS UUID[] LANGUAGE sql STABLE AS $$
  SELECT ARRAY(SELECT DISTINCT id FROM (
    SELECT booking.owner_user_id AS id UNION ALL
    SELECT candidate.user_id FROM unnest(booking.attendee_user_ids) AS candidate(user_id) WHERE booking.status = 'PENDING' OR booking.event_id IS NULL OR
      NOT EXISTS(SELECT 1 FROM calendar_events WHERE id = booking.event_id) OR
      EXISTS(SELECT 1 FROM calendar_event_attendees a WHERE a.event_id = booking.event_id AND a.user_id = candidate.user_id AND a.removed_at IS NULL AND a.response <> 'DECLINED')
  ) subjects)
$$;

CREATE FUNCTION calendar_booking_selection_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE users UUID[]; resources UUID[]; must_validate BOOLEAN;
BEGIN
  PERFORM calendar_booking_lock_workspace(NEW.workspace_id);
  IF cardinality(NEW.attendee_user_ids) + cardinality(NEW.resource_ids) > 49 OR
    array_position(NEW.attendee_user_ids, NULL) IS NOT NULL OR array_position(NEW.resource_ids, NULL) IS NOT NULL OR
    NEW.owner_user_id = ANY(NEW.attendee_user_ids) OR
    cardinality(NEW.attendee_user_ids) <> (SELECT count(DISTINCT id) FROM unnest(NEW.attendee_user_ids) id) OR
    cardinality(NEW.resource_ids) <> (SELECT count(DISTINCT id) FROM unnest(NEW.resource_ids) id) THEN
    RAISE EXCEPTION 'BOOKING_PAGE_INVALID' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'calendar_booking_pages' THEN
    -- Preserve composite foreign-key errors for an owner from another Workspace.
    IF NOT EXISTS(SELECT 1 FROM workspace_memberships WHERE workspace_id = NEW.workspace_id AND user_id = NEW.owner_user_id) THEN RETURN NEW; END IF;
    must_validate := TG_OP = 'INSERT';
    IF TG_OP = 'UPDATE' THEN must_validate := NEW.attendee_user_ids <> OLD.attendee_user_ids OR NEW.resource_ids <> OLD.resource_ids OR
      NEW.owner_user_id <> OLD.owner_user_id OR (NEW.status = 'PUBLISHED' AND OLD.status <> 'PUBLISHED'); END IF;
    users := ARRAY[NEW.owner_user_id] || NEW.attendee_user_ids; resources := NEW.resource_ids;
  ELSE
    must_validate := TG_OP = 'INSERT';
    IF TG_OP = 'UPDATE' THEN
      IF NEW.attendee_user_ids <> OLD.attendee_user_ids OR NEW.resource_ids <> OLD.resource_ids THEN
        RAISE EXCEPTION 'BOOKING_STATE_INVALID' USING ERRCODE = '23514';
      END IF;
      must_validate := NEW.status IS DISTINCT FROM OLD.status OR NEW.start_at <> OLD.start_at OR NEW.end_at <> OLD.end_at OR
        NEW.reserved_start_at <> OLD.reserved_start_at OR NEW.reserved_end_at <> OLD.reserved_end_at;
    END IF;
    must_validate := must_validate AND NEW.status IN ('PENDING', 'CONFIRMED');
    users := calendar_booking_user_ids(NEW); resources := NEW.resource_ids;
  END IF;
  IF must_validate THEN
    IF EXISTS(SELECT 1 FROM unnest(users) subject WHERE NOT EXISTS(
      SELECT 1 FROM workspace_memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = NEW.workspace_id AND m.user_id = subject
      AND m.status = 'ACTIVE' AND NOT m.is_deleted AND u.status = 'ACTIVE' AND NOT u.is_deleted)) OR
      EXISTS(SELECT 1 FROM unnest(resources) subject WHERE NOT EXISTS(SELECT 1 FROM calendar_resources r WHERE r.id = subject AND r.workspace_id = NEW.workspace_id
        AND r.is_active AND NOT r.is_deleted AND (r.capacity IS NULL OR r.capacity >= cardinality(users) + 1))) THEN
      RAISE EXCEPTION 'BOOKING_SLOT_UNAVAILABLE' USING ERRCODE = '23514';
    END IF;
    IF TG_TABLE_NAME = 'calendar_bookings' THEN
      IF TG_OP = 'INSERT' AND EXISTS(SELECT 1 FROM calendar_booking_pages p WHERE p.id = NEW.booking_page_id AND
        (p.attendee_user_ids <> NEW.attendee_user_ids OR p.resource_ids <> NEW.resource_ids)) THEN
        RAISE EXCEPTION 'BOOKING_STATE_INVALID' USING ERRCODE = '23514';
      END IF;
      IF EXISTS(SELECT 1 FROM calendar_bookings b WHERE b.workspace_id = NEW.workspace_id AND b.id <> NEW.id AND b.status IN ('PENDING', 'CONFIRMED')
        AND ((b.owner_user_id <> NEW.owner_user_id AND calendar_booking_user_ids(b) && users) OR b.resource_ids && resources)
        AND tstzrange(b.reserved_start_at, b.reserved_end_at, '[)') && tstzrange(NEW.reserved_start_at, NEW.reserved_end_at, '[)')) OR
        EXISTS(SELECT 1 FROM calendar_events e WHERE e.workspace_id = NEW.workspace_id AND e.id IS DISTINCT FROM NEW.event_id
          AND NOT e.is_deleted AND e.status <> 'CANCELLED' AND e.busy_status = 'BUSY' AND e.recurrence_rule_id IS NULL AND e.recurrence_parent_event_id IS NULL
          AND (e.organizer_user_id = ANY(users) OR EXISTS(SELECT 1 FROM calendar_event_attendees a WHERE a.event_id = e.id AND a.user_id = ANY(users) AND a.removed_at IS NULL AND a.response <> 'DECLINED'))
          AND tstzrange(CASE WHEN e.is_all_day THEN e.start_date::timestamp AT TIME ZONE e.source_timezone ELSE e.start_at END,
            CASE WHEN e.is_all_day THEN e.end_date::timestamp AT TIME ZONE e.source_timezone ELSE e.end_at END, '[)') && tstzrange(NEW.reserved_start_at, NEW.reserved_end_at, '[)')) OR
        EXISTS(SELECT 1 FROM calendar_resource_bookings r WHERE r.workspace_id = NEW.workspace_id AND r.resource_id = ANY(resources)
          AND r.event_id IS DISTINCT FROM NEW.event_id AND r.status = 'ACTIVE' AND r.recurrence_id <> '__SERIES__'
          AND tstzrange(r.start_at, r.end_at, '[)') && tstzrange(NEW.reserved_start_at, NEW.reserved_end_at, '[)')) THEN
        RAISE EXCEPTION 'BOOKING_SLOT_UNAVAILABLE' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER calendar_booking_selection_guard BEFORE INSERT OR UPDATE ON calendar_bookings FOR EACH ROW EXECUTE FUNCTION calendar_booking_selection_guard();
CREATE TRIGGER calendar_booking_selection_guard BEFORE INSERT OR UPDATE ON calendar_booking_pages FOR EACH ROW EXECUTE FUNCTION calendar_booking_selection_guard();

CREATE FUNCTION calendar_booking_selected_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event calendar_events%ROWTYPE; subject UUID; event_start TIMESTAMPTZ; event_end TIMESTAMPTZ;
BEGIN
  PERFORM calendar_booking_lock_workspace(NEW.workspace_id);
  IF TG_TABLE_NAME = 'calendar_events' THEN
    event := NEW; subject := NEW.organizer_user_id;
  ELSE
    IF NEW.removed_at IS NOT NULL OR NEW.response = 'DECLINED' THEN RETURN NEW; END IF;
    SELECT * INTO event FROM calendar_events WHERE id = NEW.event_id AND workspace_id = NEW.workspace_id;
    subject := NEW.user_id;
  END IF;
  IF event.id IS NULL OR event.is_deleted OR event.status = 'CANCELLED' OR event.busy_status <> 'BUSY' OR event.recurrence_rule_id IS NOT NULL OR event.recurrence_parent_event_id IS NOT NULL THEN RETURN NEW; END IF;
  event_start := CASE WHEN event.is_all_day THEN event.start_date::timestamp AT TIME ZONE event.source_timezone ELSE event.start_at END;
  event_end := CASE WHEN event.is_all_day THEN event.end_date::timestamp AT TIME ZONE event.source_timezone ELSE event.end_at END;
  IF event_start IS NULL OR event_end IS NULL OR event_end <= event_start THEN RETURN NEW; END IF;
  IF EXISTS(SELECT 1 FROM calendar_bookings b WHERE b.workspace_id = event.workspace_id AND b.event_id IS DISTINCT FROM event.id AND b.status IN ('PENDING', 'CONFIRMED')
    AND (subject = ANY(calendar_booking_user_ids(b)) OR EXISTS(SELECT 1 FROM calendar_event_attendees a WHERE a.event_id = event.id AND
      a.user_id = ANY(calendar_booking_user_ids(b)) AND a.removed_at IS NULL AND a.response <> 'DECLINED'))
    AND tstzrange(event_start, event_end, '[)') && tstzrange(b.reserved_start_at, b.reserved_end_at, '[)')) THEN
    RAISE EXCEPTION 'BOOKING_SLOT_UNAVAILABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER calendar_booking_selected_event_guard BEFORE INSERT OR UPDATE ON calendar_events FOR EACH ROW EXECUTE FUNCTION calendar_booking_selected_event_guard();
CREATE TRIGGER calendar_booking_selected_attendee_guard BEFORE INSERT OR UPDATE ON calendar_event_attendees FOR EACH ROW EXECUTE FUNCTION calendar_booking_selected_event_guard();

CREATE FUNCTION calendar_booking_resource_hold_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM calendar_booking_lock_workspace(NEW.workspace_id);
  IF NEW.status = 'ACTIVE' AND NEW.recurrence_id <> '__SERIES__' AND EXISTS(SELECT 1 FROM calendar_bookings b WHERE
    b.workspace_id = NEW.workspace_id AND b.event_id IS DISTINCT FROM NEW.event_id AND b.status IN ('PENDING', 'CONFIRMED') AND NEW.resource_id = ANY(b.resource_ids)
    AND tstzrange(NEW.start_at, NEW.end_at, '[)') && tstzrange(b.reserved_start_at, b.reserved_end_at, '[)')) THEN
    RAISE EXCEPTION 'BOOKING_SLOT_UNAVAILABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
-- This name sorts after the resource guard, which supplies authoritative single-Event boundaries.
CREATE TRIGGER calendar_resource_selected_hold_guard BEFORE INSERT OR UPDATE ON calendar_resource_bookings FOR EACH ROW EXECUTE FUNCTION calendar_booking_resource_hold_guard();

CREATE FUNCTION calendar_booking_subject_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target UUID; booking calendar_bookings%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'calendar_bookings' THEN
    target := NEW.id;
  ELSE
    SELECT id INTO target FROM calendar_bookings WHERE event_id = COALESCE(to_jsonb(NEW)->>'event_id', to_jsonb(OLD)->>'event_id')::uuid;
  END IF;
  IF target IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO booking FROM calendar_bookings WHERE id = target AND status = 'CONFIRMED';
  IF booking.id IS NULL THEN RETURN NULL; END IF;
  IF EXISTS(SELECT 1 FROM unnest(booking.attendee_user_ids) candidate WHERE NOT EXISTS(
      SELECT 1 FROM calendar_event_attendees a WHERE a.event_id = booking.event_id AND a.user_id = candidate AND a.workspace_id = booking.workspace_id)) OR
    EXISTS(SELECT 1 FROM calendar_resources r WHERE r.id = ANY(booking.resource_ids) AND r.workspace_id = booking.workspace_id AND r.is_active AND NOT r.is_deleted AND
      NOT EXISTS(SELECT 1 FROM calendar_resource_bookings reservation WHERE reservation.workspace_id = booking.workspace_id AND
        reservation.event_id = booking.event_id AND reservation.resource_id = r.id AND reservation.series_booking_id IS NULL AND reservation.status = 'ACTIVE')) THEN
    RAISE EXCEPTION 'BOOKING_EVENT_MANAGED' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER calendar_booking_subject_consistency AFTER INSERT OR UPDATE ON calendar_bookings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION calendar_booking_subject_consistency();
CREATE CONSTRAINT TRIGGER calendar_booking_resource_consistency AFTER INSERT OR UPDATE OR DELETE ON calendar_resource_bookings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION calendar_booking_subject_consistency();
CREATE CONSTRAINT TRIGGER calendar_booking_attendee_consistency AFTER INSERT OR UPDATE OR DELETE ON calendar_event_attendees
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION calendar_booking_subject_consistency();
