-- Workspace revisions fence authoritative application reads against concurrent Calendar/authorization writes.
CREATE TABLE calendar_availability_epochs (
  id UUID PRIMARY KEY, workspace_id UUID NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
  epoch INTEGER NOT NULL DEFAULT 0 CHECK(epoch >= 0), CHECK(id = workspace_id)
);
CREATE FUNCTION calendar_booking_lock_workspace(p_workspace UUID) RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE current_epoch INTEGER;
BEGIN
  INSERT INTO calendar_availability_epochs(id, workspace_id) SELECT id, id FROM workspaces WHERE id = p_workspace
    ON CONFLICT(workspace_id) DO NOTHING;
  SELECT epoch INTO current_epoch FROM calendar_availability_epochs WHERE workspace_id = p_workspace FOR UPDATE;
  RETURN coalesce(current_epoch, 0);
END $$;
CREATE FUNCTION calendar_booking_source_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_data JSONB; new_data JSONB; scope_id UUID;
BEGIN
  old_data := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
  new_data := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) ELSE '{}'::jsonb END;
  FOR scope_id IN
    SELECT DISTINCT candidate FROM (
      SELECT (old_data->>'workspace_id')::uuid candidate UNION SELECT (new_data->>'workspace_id')::uuid
      UNION SELECT workspace_id FROM roles WHERE TG_TABLE_NAME = 'role_permissions' AND id IN ((old_data->>'role_id')::uuid, (new_data->>'role_id')::uuid)
      UNION SELECT workspace_id FROM workspace_memberships WHERE TG_TABLE_NAME = 'users' AND user_id IN ((old_data->>'id')::uuid, (new_data->>'id')::uuid)
      UNION SELECT r.workspace_id FROM roles r JOIN role_permissions rp ON rp.role_id = r.id WHERE TG_TABLE_NAME = 'permissions' AND rp.permission_id IN ((old_data->>'id')::uuid, (new_data->>'id')::uuid)
      UNION SELECT (old_data->>'id')::uuid WHERE TG_TABLE_NAME = 'workspaces'
      UNION SELECT (new_data->>'id')::uuid WHERE TG_TABLE_NAME = 'workspaces'
    ) targets WHERE candidate IS NOT NULL ORDER BY candidate
  LOOP
    PERFORM calendar_booking_lock_workspace(scope_id);
    UPDATE calendar_availability_epochs SET epoch = epoch + 1 WHERE workspace_id = scope_id;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;

CREATE TABLE calendar_bookings (
  id UUID PRIMARY KEY, workspace_id UUID NOT NULL, booking_page_id UUID NOT NULL, owner_user_id UUID NOT NULL, calendar_id UUID NOT NULL,
  event_id UUID UNIQUE, guest_name TEXT NOT NULL CHECK(length(btrim(guest_name)) BETWEEN 1 AND 200),
  guest_email TEXT NOT NULL CHECK(length(guest_email) <= 320 AND guest_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'), guest_phone TEXT CHECK(length(guest_phone) <= 50),
  start_at TIMESTAMPTZ(6) NOT NULL, end_at TIMESTAMPTZ(6) NOT NULL CHECK(end_at > start_at AND end_at - start_at <= interval '1 day'),
  reserved_start_at TIMESTAMPTZ(6) NOT NULL, reserved_end_at TIMESTAMPTZ(6) NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED', 'NO_SHOW')),
  idempotency_key UUID NOT NULL, request_hash TEXT NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
  token_nonce TEXT NOT NULL CHECK(length(token_nonce) >= 32), token_generation INTEGER NOT NULL DEFAULT 1 CHECK(token_generation > 0),
  token_expires_at TIMESTAMPTZ(6) NOT NULL, cancellation_token_hash TEXT UNIQUE, reschedule_token_hash TEXT UNIQUE,
  source_epoch INTEGER NOT NULL CHECK(source_epoch >= 0), page_version INTEGER NOT NULL CHECK(page_version > 0), rules_version INTEGER NOT NULL CHECK(rules_version > 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0), created_at TIMESTAMPTZ(6) NOT NULL, updated_at TIMESTAMPTZ(6) NOT NULL,
  UNIQUE(booking_page_id, idempotency_key),
  FOREIGN KEY(workspace_id, booking_page_id) REFERENCES calendar_booking_pages(workspace_id, id) ON DELETE NO ACTION,
  FOREIGN KEY(workspace_id, owner_user_id) REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE NO ACTION,
  FOREIGN KEY(workspace_id, calendar_id) REFERENCES calendars(workspace_id, id) ON DELETE NO ACTION,
  FOREIGN KEY(workspace_id, event_id) REFERENCES calendar_events(workspace_id, id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CHECK(reserved_start_at <= start_at AND reserved_end_at >= end_at AND start_at - reserved_start_at <= interval '1 day' AND reserved_end_at - end_at <= interval '1 day'),
  CHECK(status <> 'PENDING' OR event_id IS NULL), CHECK(status <> 'CONFIRMED' OR event_id IS NOT NULL),
  CHECK(cancellation_token_hash IS NULL OR cancellation_token_hash ~ '^[0-9a-f]{64}$'),
  CHECK(reschedule_token_hash IS NULL OR reschedule_token_hash ~ '^[0-9a-f]{64}$'),
  CHECK(status <> 'CANCELLED' OR (cancellation_token_hash IS NULL AND reschedule_token_hash IS NULL))
);
ALTER TABLE calendar_bookings ADD CONSTRAINT calendar_booking_host_exclusive EXCLUDE USING gist
  (workspace_id WITH =, owner_user_id WITH =, tstzrange(reserved_start_at, reserved_end_at, '[)') WITH &&)
  WHERE(status IN ('PENDING', 'CONFIRMED'));
CREATE INDEX calendar_bookings_workspace_owner ON calendar_bookings(workspace_id, owner_user_id, status);

CREATE FUNCTION calendar_booking_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_epoch INTEGER; page calendar_booking_pages%ROWTYPE; rules calendar_availability_rules%ROWTYPE; must_validate BOOLEAN;
BEGIN
  current_epoch := calendar_booking_lock_workspace(NEW.workspace_id);
  must_validate := TG_OP = 'INSERT';
  IF TG_OP = 'UPDATE' THEN
    IF OLD.workspace_id <> NEW.workspace_id OR OLD.booking_page_id <> NEW.booking_page_id OR OLD.owner_user_id <> NEW.owner_user_id OR
      OLD.calendar_id <> NEW.calendar_id OR OLD.idempotency_key <> NEW.idempotency_key OR OLD.request_hash <> NEW.request_hash OR OLD.token_nonce <> NEW.token_nonce OR
      (OLD.event_id IS NOT NULL AND OLD.event_id IS DISTINCT FROM NEW.event_id) OR
      (OLD.status IN ('CANCELLED', 'COMPLETED', 'NO_SHOW') AND NEW.status <> OLD.status) THEN
      RAISE EXCEPTION 'BOOKING_STATE_INVALID' USING ERRCODE = '23514';
    END IF;
    IF NEW.version <> OLD.version + 1 THEN RAISE EXCEPTION 'RESOURCE_VERSION_CONFLICT' USING ERRCODE = '23514'; END IF;
    must_validate := OLD.status IS DISTINCT FROM NEW.status OR OLD.start_at <> NEW.start_at OR OLD.end_at <> NEW.end_at OR
      OLD.reserved_start_at <> NEW.reserved_start_at OR OLD.reserved_end_at <> NEW.reserved_end_at;
  END IF;
  IF NEW.status IN ('PENDING', 'CONFIRMED') AND must_validate THEN
    SELECT * INTO page FROM calendar_booking_pages WHERE id = NEW.booking_page_id AND workspace_id = NEW.workspace_id;
    SELECT * INTO rules FROM calendar_availability_rules WHERE page_id = NEW.booking_page_id AND workspace_id = NEW.workspace_id;
    IF page.id IS NULL OR rules.id IS NULL THEN RETURN NEW; END IF; -- Composite FKs report foreign parents.
    IF NEW.source_epoch <> current_epoch OR page.is_deleted OR page.status <> 'PUBLISHED' OR page.owner_user_id <> NEW.owner_user_id OR
      page.calendar_id <> NEW.calendar_id OR page.version <> NEW.page_version OR rules.version <> NEW.rules_version OR
      NEW.end_at - NEW.start_at <> make_interval(mins => page.duration_minutes) OR
      NEW.start_at - NEW.reserved_start_at <> make_interval(mins => page.buffer_before_minutes) OR
      NEW.reserved_end_at - NEW.end_at <> make_interval(mins => page.buffer_after_minutes) OR
      NOT EXISTS(SELECT 1 FROM workspace_memberships m JOIN users u ON u.id = m.user_id JOIN workspaces w ON w.id = m.workspace_id
        WHERE m.workspace_id = NEW.workspace_id AND m.user_id = NEW.owner_user_id AND m.status = 'ACTIVE' AND NOT m.is_deleted AND u.status = 'ACTIVE' AND NOT u.is_deleted AND NOT w.is_deleted) OR
      NOT EXISTS(SELECT 1 FROM calendars WHERE id = NEW.calendar_id AND workspace_id = NEW.workspace_id AND is_active AND NOT is_deleted AND NOT is_read_only) THEN
      RAISE EXCEPTION 'BOOKING_SLOT_UNAVAILABLE' USING ERRCODE = '23514';
    END IF;
    IF EXISTS(SELECT 1 FROM calendar_events e WHERE e.workspace_id = NEW.workspace_id AND e.id IS DISTINCT FROM NEW.event_id
      AND NOT e.is_deleted AND e.status <> 'CANCELLED' AND e.busy_status = 'BUSY' AND e.recurrence_rule_id IS NULL AND e.recurrence_parent_event_id IS NULL
      AND (e.organizer_user_id = NEW.owner_user_id OR EXISTS(SELECT 1 FROM calendar_event_attendees a WHERE a.event_id = e.id AND a.user_id = NEW.owner_user_id AND a.removed_at IS NULL AND a.response <> 'DECLINED'))
      AND tstzrange(CASE WHEN e.is_all_day THEN e.start_date::timestamp AT TIME ZONE e.source_timezone ELSE e.start_at END,
        CASE WHEN e.is_all_day THEN e.end_date::timestamp AT TIME ZONE e.source_timezone ELSE e.end_at END, '[)') && tstzrange(NEW.reserved_start_at, NEW.reserved_end_at, '[)')) THEN
      RAISE EXCEPTION 'BOOKING_SLOT_UNAVAILABLE' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER calendar_booking_guard BEFORE INSERT OR UPDATE ON calendar_bookings FOR EACH ROW EXECUTE FUNCTION calendar_booking_guard();

-- Events inserted after reservation acquisition may be the reservation's own Event. Others cannot overlap holds.
CREATE FUNCTION calendar_booking_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_start TIMESTAMPTZ; event_end TIMESTAMPTZ;
BEGIN
  PERFORM calendar_booking_lock_workspace(NEW.workspace_id);
  IF NOT NEW.is_deleted AND NEW.status <> 'CANCELLED' AND NEW.busy_status = 'BUSY' AND NEW.recurrence_rule_id IS NULL AND NEW.recurrence_parent_event_id IS NULL THEN
    event_start := CASE WHEN NEW.is_all_day THEN NEW.start_date::timestamp AT TIME ZONE NEW.source_timezone ELSE NEW.start_at END;
    event_end := CASE WHEN NEW.is_all_day THEN NEW.end_date::timestamp AT TIME ZONE NEW.source_timezone ELSE NEW.end_at END;
    IF EXISTS(SELECT 1 FROM calendar_bookings b WHERE b.workspace_id = NEW.workspace_id AND b.event_id IS DISTINCT FROM NEW.id AND b.status IN ('PENDING', 'CONFIRMED')
      AND (b.owner_user_id = NEW.organizer_user_id OR EXISTS(SELECT 1 FROM calendar_event_attendees a WHERE a.event_id = NEW.id AND a.user_id = b.owner_user_id AND a.removed_at IS NULL AND a.response <> 'DECLINED'))
      AND tstzrange(event_start, event_end, '[)') && tstzrange(b.reserved_start_at, b.reserved_end_at, '[)')) THEN
      RAISE EXCEPTION 'BOOKING_SLOT_UNAVAILABLE' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER calendar_booking_event_guard BEFORE INSERT OR UPDATE ON calendar_events FOR EACH ROW EXECUTE FUNCTION calendar_booking_event_guard();
CREATE FUNCTION calendar_booking_event_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE booking calendar_bookings%ROWTYPE; event calendar_events%ROWTYPE; target UUID;
BEGIN
  target := CASE WHEN TG_TABLE_NAME = 'calendar_bookings' THEN (to_jsonb(NEW)->>'event_id')::uuid ELSE NEW.id END;
  IF target IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO booking FROM calendar_bookings WHERE event_id = target;
  IF booking.id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO event FROM calendar_events WHERE id = target;
  IF event.id IS NULL THEN RETURN NEW; END IF; -- Deferred FK reports missing Events.
  IF booking.workspace_id <> event.workspace_id OR booking.calendar_id <> event.calendar_id OR booking.owner_user_id <> event.organizer_user_id OR
    event.is_all_day OR event.recurrence_rule_id IS NOT NULL OR event.recurrence_parent_event_id IS NOT NULL OR
    booking.start_at <> event.start_at OR booking.end_at <> event.end_at OR
    (booking.status = 'CONFIRMED' AND (event.is_deleted OR event.status = 'CANCELLED' OR event.busy_status <> 'BUSY')) OR
    (booking.status = 'CANCELLED' AND NOT event.is_deleted AND event.status <> 'CANCELLED') THEN
    RAISE EXCEPTION 'BOOKING_EVENT_MANAGED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER calendar_booking_event_consistency AFTER INSERT OR UPDATE ON calendar_bookings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION calendar_booking_event_consistency();
CREATE CONSTRAINT TRIGGER calendar_event_booking_consistency AFTER INSERT OR UPDATE ON calendar_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION calendar_booking_event_consistency();

DO $$
DECLARE source_table TEXT;
BEGIN
  FOREACH source_table IN ARRAY ARRAY['calendars', 'calendar_events', 'calendar_event_attendees', 'calendar_recurrence_rules',
    'calendar_recurrence_exceptions', 'calendar_recurrence_ranges', 'business_calendars', 'user_working_schedules',
    'calendar_booking_pages', 'calendar_availability_rules', 'calendar_permissions', 'roles', 'role_permissions',
    'workspace_memberships', 'users', 'permissions', 'projects', 'project_members', 'departments', 'department_members'] LOOP
    EXECUTE format('CREATE TRIGGER calendar_booking_source_epoch BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION calendar_booking_source_epoch()', source_table);
  END LOOP;
END $$;
CREATE TRIGGER calendar_booking_source_epoch BEFORE UPDATE ON workspaces FOR EACH ROW EXECUTE FUNCTION calendar_booking_source_epoch();
