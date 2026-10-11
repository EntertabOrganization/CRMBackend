CREATE TYPE "CalendarReminderChannel" AS ENUM ('IN_APP', 'EMAIL', 'PUSH');
CREATE TYPE "CalendarReminderStatus" AS ENUM ('SCHEDULED', 'SENT', 'CANCELLED', 'FAILED');
CREATE TABLE calendar_event_reminders (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  event_id UUID NOT NULL,
  attendee_user_id UUID NOT NULL,
  recurrence_rule_id UUID,
  recurrence_id TEXT,
  offset_seconds INTEGER,
  remind_at TIMESTAMPTZ(6),
  due_at TIMESTAMPTZ(6) NOT NULL,
  channel "CalendarReminderChannel" NOT NULL,
  status "CalendarReminderStatus" NOT NULL DEFAULT 'SCHEDULED',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ(6) NOT NULL,
  updated_at TIMESTAMPTZ(6) NOT NULL,
  FOREIGN KEY (workspace_id, event_id) REFERENCES calendar_events(workspace_id, id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id, event_id, recurrence_rule_id) REFERENCES calendar_recurrence_rules(workspace_id, event_id, id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id, attendee_user_id) REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE NO ACTION,
  CONSTRAINT calendar_reminder_timing CHECK ((offset_seconds IS NULL) <> (remind_at IS NULL) AND
    (offset_seconds IS NULL OR offset_seconds BETWEEN 0 AND 31536000) AND (remind_at IS NULL OR due_at = remind_at)),
  CONSTRAINT calendar_reminder_identity CHECK ((recurrence_rule_id IS NULL) = (recurrence_id IS NULL)),
  CONSTRAINT calendar_reminder_version CHECK (version > 0)
);
CREATE INDEX calendar_reminders_event_recipient ON calendar_event_reminders(workspace_id, event_id, attendee_user_id);
CREATE INDEX calendar_reminders_due ON calendar_event_reminders(status, due_at);
CREATE FUNCTION collab_calendar_reminder_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.workspace_id <> NEW.workspace_id OR OLD.event_id <> NEW.event_id OR OLD.attendee_user_id <> NEW.attendee_user_id OR
     OLD.recurrence_rule_id IS DISTINCT FROM NEW.recurrence_rule_id OR OLD.recurrence_id IS DISTINCT FROM NEW.recurrence_id THEN
    RAISE EXCEPTION 'RECURRENCE_SCOPE_INVALID' USING ERRCODE = '23514';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'RESOURCE_VERSION_CONFLICT' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER calendar_reminder_guard BEFORE UPDATE ON calendar_event_reminders FOR EACH ROW EXECUTE FUNCTION collab_calendar_reminder_guard();
