CREATE TABLE calendar_availability_rebuilds (
  id UUID PRIMARY KEY, workspace_id UUID NOT NULL, event_id UUID NOT NULL, recurrence_rule_id UUID NOT NULL,
  event_version INTEGER NOT NULL CHECK(event_version > 0), rule_version INTEGER NOT NULL CHECK(rule_version > 0),
  start_at TIMESTAMPTZ(6) NOT NULL, end_at TIMESTAMPTZ(6) NOT NULL CHECK(end_at > start_at AND end_at - start_at <= interval '31 days'),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'READY', 'FAILED', 'CANCELLED')),
  cursor_recurrence_id TEXT, cursor_ordinal INTEGER NOT NULL DEFAULT 0 CHECK(cursor_ordinal >= 0),
  busy JSONB NOT NULL CHECK(jsonb_typeof(busy) = 'array'), failures INTEGER NOT NULL DEFAULT 0 CHECK(failures >= 0 AND failures <= 3),
  next_attempt_at TIMESTAMPTZ(6), last_error_code TEXT, expires_at TIMESTAMPTZ(6) NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0), created_at TIMESTAMPTZ(6) NOT NULL, updated_at TIMESTAMPTZ(6) NOT NULL,
  UNIQUE(workspace_id, event_id, recurrence_rule_id, event_version, rule_version, start_at, end_at),
  FOREIGN KEY(workspace_id, event_id) REFERENCES calendar_events(workspace_id, id) ON DELETE NO ACTION,
  FOREIGN KEY(workspace_id, event_id, recurrence_rule_id) REFERENCES calendar_recurrence_rules(workspace_id, event_id, id) ON DELETE NO ACTION
);
CREATE INDEX calendar_availability_rebuild_due ON calendar_availability_rebuilds(status, next_attempt_at, updated_at);
CREATE FUNCTION calendar_availability_rebuild_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item JSONB; interval_start TIMESTAMPTZ; interval_end TIMESTAMPTZ;
BEGIN
  FOR item IN SELECT value FROM jsonb_array_elements(NEW.busy) LOOP
    BEGIN
      interval_start := (item->>'startAt')::timestamptz;
      interval_end := (item->>'endAt')::timestamptz;
      IF interval_start IS NULL OR interval_end IS NULL OR interval_start >= interval_end OR
        interval_start < NEW.start_at OR interval_end > NEW.end_at THEN
        RAISE EXCEPTION 'AVAILABILITY_INVALID_RANGE' USING ERRCODE = '23514';
      END IF;
    EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'AVAILABILITY_INVALID_RANGE' USING ERRCODE = '23514'; END;
  END LOOP;
  IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;
  IF OLD.workspace_id <> NEW.workspace_id OR OLD.event_id <> NEW.event_id OR OLD.recurrence_rule_id <> NEW.recurrence_rule_id OR
    OLD.event_version <> NEW.event_version OR OLD.rule_version <> NEW.rule_version OR OLD.start_at <> NEW.start_at OR OLD.end_at <> NEW.end_at THEN
    RAISE EXCEPTION 'RECURRENCE_SCOPE_INVALID' USING ERRCODE = '23514';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN RAISE EXCEPTION 'RESOURCE_VERSION_CONFLICT' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER calendar_availability_rebuild_guard BEFORE INSERT OR UPDATE ON calendar_availability_rebuilds
  FOR EACH ROW EXECUTE FUNCTION calendar_availability_rebuild_guard();
