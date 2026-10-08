-- CreateEnum
CREATE TYPE "CalendarRecurrenceExceptionType" AS ENUM ('CANCELLED', 'MODIFIED');

-- AlterTable
ALTER TABLE "calendar_events" ADD COLUMN     "recurrence_identity" TEXT,
ADD COLUMN     "recurrence_parent_event_id" UUID;

-- CreateTable
CREATE TABLE "calendar_recurrence_rules" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "rrule_text" TEXT NOT NULL,
    "source_timezone" TEXT NOT NULL,
    "dtstart_local" TEXT NOT NULL,
    "is_all_day" BOOLEAN NOT NULL,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "calendar_recurrence_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_recurrence_exceptions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "recurrence_rule_id" UUID NOT NULL,
    "recurrence_id" TEXT NOT NULL,
    "exception_type" "CalendarRecurrenceExceptionType" NOT NULL,
    "override_event_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "calendar_recurrence_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_recurrence_ranges" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "recurrence_rule_id" UUID NOT NULL,
    "recurrence_id" TEXT NOT NULL,
    "title" TEXT,
    "has_description" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "has_location" BOOLEAN NOT NULL DEFAULT false,
    "location" TEXT,
    "source_timezone" TEXT,
    "status" "CalendarEventStatus",
    "busy_status" "CalendarBusyStatus",
    "shift_milliseconds" DOUBLE PRECISION,
    "duration_milliseconds" DOUBLE PRECISION,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "calendar_recurrence_ranges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "calendar_recurrence_rules_workspace_id_event_id_idx" ON "calendar_recurrence_rules"("workspace_id", "event_id");

-- CreateIndex
CREATE INDEX "calendar_recurrence_rules_workspace_id_is_deleted_idx" ON "calendar_recurrence_rules"("workspace_id", "is_deleted");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_recurrence_rules_workspace_id_id_key" ON "calendar_recurrence_rules"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_recurrence_rules_workspace_id_event_id_id_key" ON "calendar_recurrence_rules"("workspace_id", "event_id", "id");

-- CreateIndex
CREATE INDEX "calendar_recurrence_exceptions_workspace_id_override_event__idx" ON "calendar_recurrence_exceptions"("workspace_id", "override_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_recurrence_exceptions_workspace_id_recurrence_rule_key" ON "calendar_recurrence_exceptions"("workspace_id", "recurrence_rule_id", "recurrence_id");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_recurrence_ranges_workspace_id_recurrence_rule_id__key" ON "calendar_recurrence_ranges"("workspace_id", "recurrence_rule_id", "recurrence_id");

-- AddForeignKey
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_workspace_id_id_recurrence_rule_id_fkey" FOREIGN KEY ("workspace_id", "id", "recurrence_rule_id") REFERENCES "calendar_recurrence_rules"("workspace_id", "event_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_workspace_id_recurrence_parent_event_id_fkey" FOREIGN KEY ("workspace_id", "recurrence_parent_event_id") REFERENCES "calendar_events"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_recurrence_rules" ADD CONSTRAINT "calendar_recurrence_rules_workspace_id_event_id_fkey" FOREIGN KEY ("workspace_id", "event_id") REFERENCES "calendar_events"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_recurrence_exceptions" ADD CONSTRAINT "calendar_recurrence_exceptions_workspace_id_recurrence_rul_fkey" FOREIGN KEY ("workspace_id", "recurrence_rule_id") REFERENCES "calendar_recurrence_rules"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_recurrence_exceptions" ADD CONSTRAINT "calendar_recurrence_exceptions_workspace_id_override_event_fkey" FOREIGN KEY ("workspace_id", "override_event_id") REFERENCES "calendar_events"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_recurrence_ranges" ADD CONSTRAINT "calendar_recurrence_ranges_workspace_id_recurrence_rule_id_fkey" FOREIGN KEY ("workspace_id", "recurrence_rule_id") REFERENCES "calendar_recurrence_rules"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- The Event is persisted before its new rule. Check the cyclic link at transaction commit.
ALTER TABLE calendar_events ALTER CONSTRAINT calendar_events_workspace_id_id_recurrence_rule_id_fkey DEFERRABLE INITIALLY DEFERRED;
CREATE UNIQUE INDEX calendar_recurrence_rules_one_live_event ON calendar_recurrence_rules(workspace_id, event_id) WHERE NOT is_deleted;
ALTER TABLE calendar_events ADD CONSTRAINT calendar_event_occurrence_shape CHECK (
  (recurrence_parent_event_id IS NULL AND recurrence_identity IS NULL) OR
  (recurrence_parent_event_id IS NOT NULL AND recurrence_identity IS NOT NULL AND recurrence_parent_event_id <> id AND recurrence_rule_id IS NULL)
);
ALTER TABLE calendar_recurrence_rules ADD CONSTRAINT calendar_recurrence_rule_shape CHECK (
  version > 0 AND length(rrule_text) BETWEEN 1 AND 2000 AND
  CASE WHEN is_all_day THEN dtstart_local ~ '^\d{4}-\d{2}-\d{2}$'
  ELSE dtstart_local ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$' END
);
ALTER TABLE calendar_recurrence_ranges ADD CONSTRAINT calendar_recurrence_range_shape CHECK (
  status IS DISTINCT FROM 'CANCELLED'::"CalendarEventStatus" AND
  (shift_milliseconds IS NULL OR (abs(shift_milliseconds) <= 3155760000000 AND floor(shift_milliseconds) = shift_milliseconds)) AND
  (duration_milliseconds IS NULL OR (duration_milliseconds > 0 AND duration_milliseconds <= 3155760000000 AND floor(duration_milliseconds) = duration_milliseconds))
);
CREATE TRIGGER calendar_recurrence_rule_version BEFORE UPDATE ON calendar_recurrence_rules FOR EACH ROW EXECUTE FUNCTION collab_enforce_version_increase();

CREATE FUNCTION collab_calendar_recurrence_link_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ev calendar_events%ROWTYPE; r calendar_recurrence_rules%ROWTYPE; p calendar_events%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'calendar_events' THEN
    SELECT * INTO ev FROM calendar_events WHERE id = NEW.id;
    IF NOT FOUND THEN RETURN NEW; END IF;
  ELSE
    SELECT * INTO r FROM calendar_recurrence_rules WHERE id = NEW.id;
    IF NOT FOUND THEN RETURN NEW; END IF;
    SELECT * INTO ev FROM calendar_events WHERE workspace_id = r.workspace_id AND id = r.event_id;
    IF NOT FOUND OR ev.recurrence_parent_event_id IS NOT NULL OR
       (NOT r.is_deleted AND (ev.is_all_day <> r.is_all_day OR ev.recurrence_rule_id IS DISTINCT FROM r.id)) THEN
      RAISE EXCEPTION 'RECURRENCE_SCOPE_INVALID' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF ev.recurrence_rule_id IS NOT NULL THEN
    SELECT * INTO r FROM calendar_recurrence_rules WHERE workspace_id = ev.workspace_id AND event_id = ev.id AND id = ev.recurrence_rule_id;
    IF NOT FOUND OR r.is_deleted OR r.is_all_day <> ev.is_all_day OR ev.recurrence_parent_event_id IS NOT NULL THEN
      RAISE EXCEPTION 'RECURRENCE_SCOPE_INVALID' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF ev.recurrence_parent_event_id IS NOT NULL THEN
    SELECT * INTO p FROM calendar_events WHERE workspace_id = ev.workspace_id AND id = ev.recurrence_parent_event_id;
    IF NOT FOUND OR p.recurrence_parent_event_id IS NOT NULL OR p.calendar_id <> ev.calendar_id OR p.organizer_user_id <> ev.organizer_user_id OR
      NOT EXISTS (SELECT 1 FROM calendar_recurrence_exceptions ex JOIN calendar_recurrence_rules cr ON cr.id = ex.recurrence_rule_id AND cr.workspace_id = ex.workspace_id
                  WHERE ex.workspace_id = ev.workspace_id AND ex.override_event_id = ev.id AND ex.recurrence_id = ev.recurrence_identity AND cr.event_id = p.id) THEN
      RAISE EXCEPTION 'RECURRENCE_SCOPE_INVALID' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER calendar_recurrence_event_link AFTER INSERT OR UPDATE ON calendar_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION collab_calendar_recurrence_link_guard();
CREATE CONSTRAINT TRIGGER calendar_recurrence_rule_link AFTER INSERT OR UPDATE ON calendar_recurrence_rules DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION collab_calendar_recurrence_link_guard();

CREATE FUNCTION collab_calendar_recurrence_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r calendar_recurrence_rules%ROWTYPE; override_row calendar_events%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'calendar_recurrence_rules' THEN
    IF OLD.workspace_id <> NEW.workspace_id OR OLD.event_id <> NEW.event_id OR OLD.dtstart_local <> NEW.dtstart_local OR OLD.is_all_day <> NEW.is_all_day THEN
      RAISE EXCEPTION 'RECURRENCE_SCOPE_INVALID' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO r FROM calendar_recurrence_rules WHERE id = NEW.recurrence_rule_id AND workspace_id = NEW.workspace_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'RECURRENCE_SCOPE_INVALID' USING ERRCODE = '23514'; END IF;
  IF (r.is_all_day AND NEW.recurrence_id !~ '^\d{4}-\d{2}-\d{2}$') OR
     (NOT r.is_all_day AND NEW.recurrence_id !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$') THEN
    RAISE EXCEPTION 'RECURRENCE_SCOPE_INVALID' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'calendar_recurrence_exceptions' THEN
    IF NEW.exception_type = 'MODIFIED' AND NEW.override_event_id IS NULL THEN
      RAISE EXCEPTION 'RECURRENCE_SCOPE_INVALID' USING ERRCODE = '23514';
    END IF;
    IF NEW.override_event_id IS NOT NULL THEN
      SELECT * INTO override_row FROM calendar_events WHERE workspace_id = NEW.workspace_id AND id = NEW.override_event_id;
      IF NOT FOUND OR override_row.recurrence_parent_event_id IS DISTINCT FROM r.event_id OR override_row.recurrence_identity IS DISTINCT FROM NEW.recurrence_id THEN
        RAISE EXCEPTION 'RECURRENCE_SCOPE_INVALID' USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSE
    IF r.is_all_day AND (mod(COALESCE(NEW.shift_milliseconds,0)::numeric,86400000) <> 0 OR mod(COALESCE(NEW.duration_milliseconds,86400000)::numeric,86400000) <> 0) THEN
      RAISE EXCEPTION 'RECURRENCE_SCOPE_INVALID' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER calendar_recurrence_rule_identity BEFORE UPDATE ON calendar_recurrence_rules FOR EACH ROW EXECUTE FUNCTION collab_calendar_recurrence_identity_guard();
CREATE TRIGGER calendar_recurrence_exception_identity BEFORE INSERT OR UPDATE ON calendar_recurrence_exceptions FOR EACH ROW EXECUTE FUNCTION collab_calendar_recurrence_identity_guard();
CREATE TRIGGER calendar_recurrence_range_identity BEFORE INSERT OR UPDATE ON calendar_recurrence_ranges FOR EACH ROW EXECUTE FUNCTION collab_calendar_recurrence_identity_guard();
