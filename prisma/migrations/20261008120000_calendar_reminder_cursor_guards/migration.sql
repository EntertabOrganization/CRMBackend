ALTER TABLE calendar_event_reminders
  ADD CONSTRAINT calendar_reminder_cursor_scope CHECK (
    (is_series OR (cursor_recurrence_id IS NULL AND cursor_ordinal = 0 AND cursor_rule_version IS NULL
      AND cursor_event_version IS NULL AND NOT scan_complete AND materialized_at IS NULL))
    AND (NOT is_series_override OR series_reminder_id IS NOT NULL));
