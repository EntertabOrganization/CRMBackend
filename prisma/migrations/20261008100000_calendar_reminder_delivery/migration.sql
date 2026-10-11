ALTER TABLE calendar_event_reminders
  ADD COLUMN delivery_generation INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN next_attempt_at TIMESTAMPTZ(6),
  ADD COLUMN claim_token UUID,
  ADD COLUMN lease_expires_at TIMESTAMPTZ(6),
  ADD COLUMN sent_at TIMESTAMPTZ(6),
  ADD COLUMN delivery_reference TEXT,
  ADD COLUMN last_error_code TEXT,
  ADD CONSTRAINT calendar_reminder_generation CHECK (delivery_generation > 0 AND attempts >= 0),
  ADD CONSTRAINT calendar_reminder_lease CHECK ((claim_token IS NULL) = (lease_expires_at IS NULL)),
  ADD CONSTRAINT calendar_reminder_sent_evidence CHECK (status <> 'SENT' OR sent_at IS NOT NULL);
CREATE INDEX calendar_reminders_retry_due ON calendar_event_reminders(status, next_attempt_at, lease_expires_at)
  WHERE status IN ('SCHEDULED', 'FAILED');
