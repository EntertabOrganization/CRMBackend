ALTER TABLE calendar_event_reminders
  ALTER COLUMN due_at DROP NOT NULL,
  ADD COLUMN is_series BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN series_reminder_id UUID,
  ADD COLUMN is_series_override BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN recurrence_ordinal INTEGER,
  ADD COLUMN source_rule_version INTEGER,
  ADD COLUMN source_event_version INTEGER,
  ADD COLUMN cursor_recurrence_id TEXT,
  ADD COLUMN cursor_ordinal INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN cursor_rule_version INTEGER,
  ADD COLUMN cursor_event_version INTEGER,
  ADD COLUMN scan_complete BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN materialized_at TIMESTAMPTZ(6),
  DROP CONSTRAINT calendar_reminder_identity,
  ADD CONSTRAINT calendar_reminder_identity CHECK (
    (is_series AND recurrence_rule_id IS NOT NULL AND recurrence_id IS NULL AND series_reminder_id IS NULL
      AND offset_seconds IS NOT NULL AND remind_at IS NULL AND due_at IS NULL AND status <> 'SENT'
      AND claim_token IS NULL AND lease_expires_at IS NULL AND attempts = 0)
    OR (NOT is_series AND due_at IS NOT NULL AND (recurrence_rule_id IS NULL) = (recurrence_id IS NULL))),
  ADD CONSTRAINT calendar_reminder_child CHECK (
    (series_reminder_id IS NULL AND recurrence_ordinal IS NULL AND source_rule_version IS NULL AND source_event_version IS NULL)
    OR (NOT is_series AND series_reminder_id IS NOT NULL AND recurrence_id IS NOT NULL
      AND recurrence_ordinal > 0 AND source_rule_version > 0 AND source_event_version > 0
      AND recurrence_ordinal IS NOT NULL AND source_rule_version IS NOT NULL AND source_event_version IS NOT NULL)),
  ADD CONSTRAINT calendar_reminder_cursor CHECK (cursor_ordinal >= 0 AND
    (cursor_rule_version IS NULL OR cursor_rule_version > 0) AND (cursor_event_version IS NULL OR cursor_event_version > 0)),
  ADD CONSTRAINT calendar_reminder_workspace_id UNIQUE(workspace_id, id),
  ADD CONSTRAINT calendar_reminder_occurrence UNIQUE(series_reminder_id, recurrence_id),
  ADD CONSTRAINT calendar_reminder_parent FOREIGN KEY(workspace_id, series_reminder_id)
    REFERENCES calendar_event_reminders(workspace_id, id) ON DELETE NO ACTION;

CREATE INDEX calendar_reminder_series_scan ON calendar_event_reminders(materialized_at) WHERE is_series AND status IN ('SCHEDULED', 'FAILED');
CREATE OR REPLACE FUNCTION collab_calendar_reminder_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.workspace_id <> NEW.workspace_id OR OLD.event_id <> NEW.event_id OR OLD.attendee_user_id <> NEW.attendee_user_id OR
     OLD.recurrence_rule_id IS DISTINCT FROM NEW.recurrence_rule_id OR OLD.recurrence_id IS DISTINCT FROM NEW.recurrence_id OR
     OLD.is_series <> NEW.is_series OR OLD.series_reminder_id IS DISTINCT FROM NEW.series_reminder_id THEN
    RAISE EXCEPTION 'RECURRENCE_SCOPE_INVALID' USING ERRCODE = '23514';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'RESOURCE_VERSION_CONFLICT' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION collab_calendar_reminder_parent_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.series_reminder_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM calendar_event_reminders parent WHERE parent.id = NEW.series_reminder_id AND parent.is_series
      AND parent.workspace_id = NEW.workspace_id AND parent.event_id = NEW.event_id
      AND parent.attendee_user_id = NEW.attendee_user_id AND parent.recurrence_rule_id = NEW.recurrence_rule_id
  ) THEN
    RAISE EXCEPTION 'RECURRENCE_SCOPE_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER calendar_reminder_parent_guard BEFORE INSERT OR UPDATE ON calendar_event_reminders
  FOR EACH ROW EXECUTE FUNCTION collab_calendar_reminder_parent_guard();
