CREATE OR REPLACE FUNCTION calendar_booking_selection_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
      -- Persistence uses INSERT ... ON CONFLICT UPDATE for existing reservations.
      -- The INSERT trigger runs before conflict resolution; only new identities
      -- must match the page's current roster. Existing holds retain their snapshot.
      IF TG_OP = 'INSERT' AND NOT EXISTS(SELECT 1 FROM calendar_bookings WHERE id = NEW.id) AND
        EXISTS(SELECT 1 FROM calendar_booking_pages p WHERE p.id = NEW.booking_page_id AND
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
