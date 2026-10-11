CREATE TABLE business_calendars (
  id UUID PRIMARY KEY, workspace_id UUID NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE NO ACTION,
  timezone TEXT NOT NULL, weekly JSONB NOT NULL, holidays JSONB NOT NULL, overrides JSONB NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0), created_at TIMESTAMPTZ(6) NOT NULL, updated_at TIMESTAMPTZ(6) NOT NULL
);
CREATE TABLE user_working_schedules (
  id UUID PRIMARY KEY, workspace_id UUID NOT NULL, user_id UUID NOT NULL,
  timezone TEXT NOT NULL, weekly JSONB NOT NULL, holidays JSONB NOT NULL, overrides JSONB NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0), created_at TIMESTAMPTZ(6) NOT NULL, updated_at TIMESTAMPTZ(6) NOT NULL,
  UNIQUE(workspace_id, user_id),
  FOREIGN KEY(workspace_id, user_id) REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE NO ACTION
);
CREATE FUNCTION calendar_work_window_valid(w JSONB, weekday_required BOOLEAN) RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  RETURN coalesce(jsonb_typeof(w) = 'object' AND jsonb_typeof(w->'localStartTime') = 'string'
    AND jsonb_typeof(w->'localEndTime') = 'string'
    AND w->>'localStartTime' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    AND w->>'localEndTime' ~ '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$'
    AND w->>'localEndTime' > w->>'localStartTime'
    AND (NOT weekday_required OR (jsonb_typeof(w->'dayOfWeek') = 'number' AND w->>'dayOfWeek' ~ '^[1-7]$'))
    AND (SELECT count(*) FROM jsonb_object_keys(w)) = CASE WHEN weekday_required THEN 3 ELSE 2 END, false);
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
CREATE FUNCTION calendar_working_schedule_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item JSONB; work_window JSONB; dates TEXT[] := '{}'; day TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.workspace_id <> NEW.workspace_id OR (to_jsonb(OLD)->>'user_id') IS DISTINCT FROM (to_jsonb(NEW)->>'user_id') THEN
      RAISE EXCEPTION 'AVAILABILITY_SUBJECT_NOT_FOUND' USING ERRCODE = '23514';
    END IF;
    IF NEW.version <> OLD.version + 1 THEN RAISE EXCEPTION 'RESOURCE_VERSION_CONFLICT' USING ERRCODE = '23514'; END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE lower(name) = lower(NEW.timezone)) THEN
    RAISE EXCEPTION 'AVAILABILITY_INVALID_RANGE' USING ERRCODE = '23514';
  END IF;
  IF jsonb_typeof(NEW.weekly) <> 'array' OR jsonb_typeof(NEW.holidays) <> 'array' OR jsonb_typeof(NEW.overrides) <> 'array' THEN
    RAISE EXCEPTION 'AVAILABILITY_INVALID_RANGE' USING ERRCODE = '23514';
  END IF;
  IF jsonb_array_length(NEW.weekly) > 70 OR jsonb_array_length(NEW.holidays) > 366 OR jsonb_array_length(NEW.overrides) > 366 THEN
    RAISE EXCEPTION 'AVAILABILITY_INVALID_RANGE' USING ERRCODE = '23514';
  END IF;
  FOR work_window IN SELECT value FROM jsonb_array_elements(NEW.weekly) LOOP
    IF NOT calendar_work_window_valid(work_window, true) THEN RAISE EXCEPTION 'AVAILABILITY_INVALID_RANGE' USING ERRCODE = '23514'; END IF;
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(NEW.holidays) LOOP
    day := item #>> '{}';
    IF jsonb_typeof(item) <> 'string' OR day !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR to_char(day::date, 'YYYY-MM-DD') <> day THEN
      RAISE EXCEPTION 'AVAILABILITY_INVALID_RANGE' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(NEW.overrides) LOOP
    day := item->>'date';
    IF jsonb_typeof(item) <> 'object' OR (SELECT count(*) FROM jsonb_object_keys(item)) <> 2
      OR jsonb_typeof(item->'date') IS DISTINCT FROM 'string' OR day !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      OR to_char(day::date, 'YYYY-MM-DD') <> day OR day = ANY(dates)
      OR jsonb_typeof(item->'windows') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'AVAILABILITY_INVALID_RANGE' USING ERRCODE = '23514';
    END IF;
    dates := array_append(dates, day);
    IF jsonb_array_length(item->'windows') > 10 THEN RAISE EXCEPTION 'AVAILABILITY_INVALID_RANGE' USING ERRCODE = '23514'; END IF;
    FOR work_window IN SELECT value FROM jsonb_array_elements(item->'windows') LOOP
      IF NOT calendar_work_window_valid(work_window, false) THEN RAISE EXCEPTION 'AVAILABILITY_INVALID_RANGE' USING ERRCODE = '23514'; END IF;
    END LOOP;
  END LOOP;
  RETURN NEW;
EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
  RAISE EXCEPTION 'AVAILABILITY_INVALID_RANGE' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER business_calendar_guard BEFORE INSERT OR UPDATE ON business_calendars FOR EACH ROW EXECUTE FUNCTION calendar_working_schedule_guard();
CREATE TRIGGER user_working_schedule_guard BEFORE INSERT OR UPDATE ON user_working_schedules FOR EACH ROW EXECUTE FUNCTION calendar_working_schedule_guard();
