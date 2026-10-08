-- CreateEnum
CREATE TYPE "CalendarEventStatus" AS ENUM ('CONFIRMED', 'TENTATIVE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CalendarBusyStatus" AS ENUM ('FREE', 'BUSY');

-- CreateEnum
CREATE TYPE "CalendarAttendeeResponse" AS ENUM ('NEEDS_ACTION', 'ACCEPTED', 'TENTATIVE', 'DECLINED');

-- CreateTable
CREATE TABLE "calendar_events" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "calendar_id" UUID NOT NULL,
    "organizer_user_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "location" TEXT,
    "is_all_day" BOOLEAN NOT NULL DEFAULT false,
    "start_at" TIMESTAMPTZ(6),
    "end_at" TIMESTAMPTZ(6),
    "start_date" DATE,
    "end_date" DATE,
    "source_timezone" TEXT NOT NULL,
    "status" "CalendarEventStatus" NOT NULL DEFAULT 'CONFIRMED',
    "busy_status" "CalendarBusyStatus" NOT NULL DEFAULT 'BUSY',
    "recurrence_rule_id" UUID,
    "status_before_cancel" "CalendarEventStatus",
    "cancelled_at" TIMESTAMPTZ(6),
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "deleted_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "calendar_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_event_attendees" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "response" "CalendarAttendeeResponse" NOT NULL DEFAULT 'NEEDS_ACTION',
    "responded_at" TIMESTAMPTZ(6),
    "removed_at" TIMESTAMPTZ(6),

    CONSTRAINT "calendar_event_attendees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_external_guests" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "response" "CalendarAttendeeResponse" NOT NULL DEFAULT 'NEEDS_ACTION',
    "invite_token_hash" TEXT,
    "removed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "calendar_external_guests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_event_bindings" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "calendar_event_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_event_files" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "calendar_event_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_event_history" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "actor_user_id" UUID,
    "action" TEXT NOT NULL,
    "changes" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "calendar_event_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meeting_records" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "agenda" TEXT,
    "notes" TEXT,
    "updated_by_user_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "meeting_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meeting_decisions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "meeting_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "calendar_events_workspace_id_calendar_id_start_at_idx" ON "calendar_events"("workspace_id", "calendar_id", "start_at");

-- CreateIndex
CREATE INDEX "calendar_events_workspace_id_calendar_id_start_date_idx" ON "calendar_events"("workspace_id", "calendar_id", "start_date");

-- CreateIndex
CREATE INDEX "calendar_events_workspace_id_organizer_user_id_status_is_de_idx" ON "calendar_events"("workspace_id", "organizer_user_id", "status", "is_deleted");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_events_workspace_id_id_key" ON "calendar_events"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "calendar_event_attendees_workspace_id_user_id_removed_at_idx" ON "calendar_event_attendees"("workspace_id", "user_id", "removed_at");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_event_attendees_event_id_user_id_key" ON "calendar_event_attendees"("event_id", "user_id");

-- CreateIndex
CREATE INDEX "calendar_external_guests_workspace_id_event_id_removed_at_idx" ON "calendar_external_guests"("workspace_id", "event_id", "removed_at");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_external_guests_event_id_email_key" ON "calendar_external_guests"("event_id", "email");

-- CreateIndex
CREATE INDEX "calendar_event_bindings_workspace_id_entity_type_entity_id_idx" ON "calendar_event_bindings"("workspace_id", "entity_type", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_event_bindings_event_id_entity_type_entity_id_key" ON "calendar_event_bindings"("event_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "calendar_event_files_workspace_id_file_id_idx" ON "calendar_event_files"("workspace_id", "file_id");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_event_files_event_id_file_id_key" ON "calendar_event_files"("event_id", "file_id");

-- CreateIndex
CREATE INDEX "calendar_event_history_workspace_id_event_id_occurred_at_id_idx" ON "calendar_event_history"("workspace_id", "event_id", "occurred_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "meeting_records_event_id_key" ON "meeting_records"("event_id");

-- CreateIndex
CREATE UNIQUE INDEX "meeting_records_workspace_id_event_id_key" ON "meeting_records"("workspace_id", "event_id");

-- CreateIndex
CREATE INDEX "meeting_decisions_workspace_id_event_id_created_at_id_idx" ON "meeting_decisions"("workspace_id", "event_id", "created_at", "id");

-- AddForeignKey
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_workspace_id_calendar_id_fkey" FOREIGN KEY ("workspace_id", "calendar_id") REFERENCES "calendars"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_organizer_user_id_fkey" FOREIGN KEY ("organizer_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_event_attendees" ADD CONSTRAINT "calendar_event_attendees_workspace_id_event_id_fkey" FOREIGN KEY ("workspace_id", "event_id") REFERENCES "calendar_events"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_event_attendees" ADD CONSTRAINT "calendar_event_attendees_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_external_guests" ADD CONSTRAINT "calendar_external_guests_workspace_id_event_id_fkey" FOREIGN KEY ("workspace_id", "event_id") REFERENCES "calendar_events"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_event_bindings" ADD CONSTRAINT "calendar_event_bindings_workspace_id_event_id_fkey" FOREIGN KEY ("workspace_id", "event_id") REFERENCES "calendar_events"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_event_files" ADD CONSTRAINT "calendar_event_files_workspace_id_event_id_fkey" FOREIGN KEY ("workspace_id", "event_id") REFERENCES "calendar_events"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_event_history" ADD CONSTRAINT "calendar_event_history_workspace_id_event_id_fkey" FOREIGN KEY ("workspace_id", "event_id") REFERENCES "calendar_events"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_records" ADD CONSTRAINT "meeting_records_workspace_id_event_id_fkey" FOREIGN KEY ("workspace_id", "event_id") REFERENCES "calendar_events"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_decisions" ADD CONSTRAINT "meeting_decisions_workspace_id_event_id_fkey" FOREIGN KEY ("workspace_id", "event_id") REFERENCES "calendar_events"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;
-- Scheduling, concurrency and tenancy remain valid under independent application instances.
CREATE TRIGGER "calendar_events_version_guard" BEFORE UPDATE ON "calendar_events"
  FOR EACH ROW EXECUTE FUNCTION collab_enforce_version_increase();
CREATE TRIGGER "meeting_records_version_guard" BEFORE UPDATE ON "meeting_records"
  FOR EACH ROW EXECUTE FUNCTION collab_enforce_version_increase();
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_range_chk" CHECK (
  (is_all_day AND start_at IS NULL AND end_at IS NULL AND start_date IS NOT NULL AND end_date IS NOT NULL AND start_date < end_date)
  OR (NOT is_all_day AND start_date IS NULL AND end_date IS NULL AND start_at IS NOT NULL AND end_at IS NOT NULL AND start_at < end_at)
);
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_cancellation_chk" CHECK (
  (status = 'CANCELLED' AND cancelled_at IS NOT NULL AND status_before_cancel IS NOT NULL AND status_before_cancel <> 'CANCELLED')
  OR (status <> 'CANCELLED' AND cancelled_at IS NULL AND status_before_cancel IS NULL)
);
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_deletion_chk" CHECK (is_deleted = (deleted_at IS NOT NULL));
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_version_chk" CHECK (version > 0);
ALTER TABLE "meeting_records" ADD CONSTRAINT "meeting_records_version_chk" CHECK (version > 0);

CREATE FUNCTION calendar_event_user_tenant_guard() RETURNS trigger AS $$
DECLARE target_user uuid;
BEGIN
  target_user := (to_jsonb(NEW)->>TG_ARGV[0])::uuid;
  IF target_user IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM workspace_memberships WHERE workspace_id = NEW.workspace_id AND user_id = target_user
  ) THEN
    RAISE EXCEPTION 'EVENT_ATTENDEE_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "calendar_event_organizer_tenant_guard" BEFORE INSERT OR UPDATE ON "calendar_events"
  FOR EACH ROW EXECUTE FUNCTION calendar_event_user_tenant_guard('organizer_user_id');
CREATE TRIGGER "calendar_event_attendee_tenant_guard" BEFORE INSERT OR UPDATE ON "calendar_event_attendees"
  FOR EACH ROW EXECUTE FUNCTION calendar_event_user_tenant_guard('user_id');
CREATE TRIGGER "calendar_event_binding_author_tenant_guard" BEFORE INSERT OR UPDATE ON "calendar_event_bindings"
  FOR EACH ROW EXECUTE FUNCTION calendar_event_user_tenant_guard('created_by_user_id');
CREATE TRIGGER "calendar_event_history_author_tenant_guard" BEFORE INSERT OR UPDATE ON "calendar_event_history"
  FOR EACH ROW EXECUTE FUNCTION calendar_event_user_tenant_guard('actor_user_id');
CREATE TRIGGER "meeting_record_author_tenant_guard" BEFORE INSERT OR UPDATE ON "meeting_records"
  FOR EACH ROW EXECUTE FUNCTION calendar_event_user_tenant_guard('updated_by_user_id');
CREATE TRIGGER "meeting_decision_author_tenant_guard" BEFORE INSERT OR UPDATE ON "meeting_decisions"
  FOR EACH ROW EXECUTE FUNCTION calendar_event_user_tenant_guard('created_by_user_id');

-- Polymorphic binding targets are checked at creation; historical references survive source hard deletion.
CREATE FUNCTION calendar_event_binding_tenant_guard() RETURNS trigger AS $$
DECLARE target_table text; valid_target boolean;
BEGIN
  target_table := CASE NEW.entity_type
    WHEN 'LEAD' THEN 'crm_leads' WHEN 'DEAL' THEN 'crm_deals' WHEN 'CONTACT' THEN 'crm_contacts'
    WHEN 'COMPANY' THEN 'crm_companies' WHEN 'ACTIVITY' THEN 'crm_activities'
    WHEN 'TASK' THEN 'tasks' WHEN 'PROJECT' THEN 'projects' ELSE NULL END;
  IF target_table IS NULL THEN
    RAISE EXCEPTION 'EVENT_BINDING_INVALID' USING ERRCODE = '23514';
  END IF;
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE id = $1 AND workspace_id = $2)', target_table)
    INTO valid_target USING NEW.entity_id, NEW.workspace_id;
  IF NOT valid_target THEN
    RAISE EXCEPTION 'EVENT_BINDING_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "calendar_event_binding_tenant_guard" BEFORE INSERT ON "calendar_event_bindings"
  FOR EACH ROW EXECUTE FUNCTION calendar_event_binding_tenant_guard();
