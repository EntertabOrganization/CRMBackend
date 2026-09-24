-- CreateEnum
CREATE TYPE "CustomFieldType" AS ENUM ('TEXT', 'TEXTAREA', 'INTEGER', 'DECIMAL', 'BOOLEAN', 'DATE', 'DATETIME', 'LIST', 'MULTI_LIST', 'PHONE', 'EMAIL', 'URL', 'MONEY', 'USER_REFERENCE', 'CRM_REFERENCE', 'FILE', 'ADDRESS');

-- CreateEnum
CREATE TYPE "ActivityStatus" AS ENUM ('PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ActivityPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH');

-- CreateEnum
CREATE TYPE "ActivityDirection" AS ENUM ('INCOMING', 'OUTGOING', 'NOT_APPLICABLE');

-- AlterTable
ALTER TABLE "outbox_events" ADD COLUMN     "causation_id" TEXT,
ADD COLUMN     "correlation_id" TEXT,
ADD COLUMN     "event_version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "idempotency_key" TEXT,
ADD COLUMN     "projected_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "crm_custom_fields" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "help_text" TEXT,
    "field_type" "CustomFieldType" NOT NULL,
    "is_multiple" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "static_default_value" JSONB,
    "validation_config" JSONB,
    "reference_config" JSONB,
    "activity_type_id" UUID,
    "show_on_create" BOOLEAN NOT NULL DEFAULT true,
    "show_on_edit" BOOLEAN NOT NULL DEFAULT true,
    "show_on_detail" BOOLEAN NOT NULL DEFAULT true,
    "available_as_list_column" BOOLEAN NOT NULL DEFAULT false,
    "searchable" BOOLEAN NOT NULL DEFAULT false,
    "filterable" BOOLEAN NOT NULL DEFAULT false,
    "sortable" BOOLEAN NOT NULL DEFAULT false,
    "available_in_forms" BOOLEAN NOT NULL DEFAULT false,
    "available_in_import" BOOLEAN NOT NULL DEFAULT false,
    "available_in_export" BOOLEAN NOT NULL DEFAULT false,
    "available_in_api" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_user_id" UUID,
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_custom_fields_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_custom_field_options" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "field_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_custom_field_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_custom_field_values" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "field_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL DEFAULT 0,
    "value_text" TEXT,
    "value_integer" INTEGER,
    "value_decimal" DECIMAL(28,8),
    "value_boolean" BOOLEAN,
    "value_date" DATE,
    "value_datetime" TIMESTAMP(3),
    "value_uuid" UUID,
    "value_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_custom_field_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_field_visibility_rules" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "field_id" UUID NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "restriction" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_field_visibility_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_field_requirements" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "target_kind" TEXT NOT NULL,
    "target_system_field_key" TEXT,
    "target_custom_field_id" UUID,
    "pipeline_id" UUID,
    "stage_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "conditions" JSONB,
    "conditions_version" INTEGER NOT NULL DEFAULT 1,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_user_id" UUID,
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_field_requirements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_custom_field_migrations" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "field_id" UUID NOT NULL,
    "from_type" "CustomFieldType" NOT NULL,
    "to_type" "CustomFieldType" NOT NULL,
    "requested_by_user_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "preview" JSONB NOT NULL,
    "report" JSONB,
    "checkpoint" JSONB,
    "schema_version_before" INTEGER,
    "schema_version_after" INTEGER,
    "idempotency_key" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_custom_field_migrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_field_schema_versions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_field_schema_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_activity_types" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "icon" TEXT,
    "color_token" TEXT,
    "default_duration_minutes" INTEGER,
    "default_priority" "ActivityPriority" NOT NULL DEFAULT 'NORMAL',
    "default_direction" "ActivityDirection" NOT NULL DEFAULT 'NOT_APPLICABLE',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "owner_app" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_activity_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_activities" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "type_code" TEXT NOT NULL,
    "custom_activity_type_id" UUID,
    "subject" TEXT NOT NULL,
    "description" TEXT,
    "status" "ActivityStatus" NOT NULL DEFAULT 'PLANNED',
    "priority" "ActivityPriority" NOT NULL DEFAULT 'NORMAL',
    "direction" "ActivityDirection" NOT NULL DEFAULT 'NOT_APPLICABLE',
    "created_by_user_id" UUID,
    "responsible_user_id" UUID,
    "start_at" TIMESTAMP(3),
    "end_at" TIMESTAMP(3),
    "deadline" TIMESTAMP(3),
    "deadline_version" INTEGER NOT NULL DEFAULT 1,
    "location" TEXT,
    "result_text" TEXT,
    "completed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "cancellation_reason" TEXT,
    "reopened_at" TIMESTAMP(3),
    "adapter_kind" TEXT,
    "adapter_resource_id" TEXT,
    "external_origin" TEXT,
    "external_id" TEXT,
    "file_ids" JSONB NOT NULL DEFAULT '[]',
    "version" INTEGER NOT NULL DEFAULT 1,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "deleted_at" TIMESTAMP(3),
    "deleted_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_activity_bindings" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "activity_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_activity_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_activity_participants" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "activity_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_activity_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_activity_communications" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "activity_id" UUID NOT NULL,
    "communication_type" TEXT NOT NULL,
    "crm_entity_type" TEXT,
    "crm_entity_id" UUID,
    "normalized_value" TEXT NOT NULL,
    "raw_display_value" TEXT,
    "label" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_activity_communications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_activity_reminders" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "activity_id" UUID NOT NULL,
    "mode" TEXT NOT NULL,
    "relative_to" TEXT,
    "offset_seconds" INTEGER,
    "absolute_at" TIMESTAMP(3),
    "scheduled_for" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "occurrence_key" TEXT NOT NULL,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_activity_reminders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_activity_reminder_recipients" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "reminder_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,

    CONSTRAINT "crm_activity_reminder_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_activity_overdue_occurrences" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "activity_id" UUID NOT NULL,
    "deadline" TIMESTAMP(3) NOT NULL,
    "deadline_version" INTEGER NOT NULL,
    "emitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_activity_overdue_occurrences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_timeline_entries" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "source_event_id" TEXT NOT NULL,
    "projection_kind" TEXT NOT NULL DEFAULT 'DEFAULT',
    "source_version" INTEGER,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_user_id" UUID,
    "actor_display_snapshot" TEXT,
    "summary_code" TEXT NOT NULL,
    "summary_text_snapshot" TEXT,
    "presentation_snapshot" JSONB NOT NULL,
    "correlation_id" TEXT,
    "projection_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_timeline_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_timeline_comments" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "linked_activity_id" UUID,
    "author_user_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "file_ids" JSONB NOT NULL DEFAULT '[]',
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "deleted_at" TIMESTAMP(3),
    "deleted_by_user_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_timeline_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_timeline_comment_mentions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "comment_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_timeline_comment_mentions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "crm_custom_fields_workspace_id_entity_type_is_active_sort_o_idx" ON "crm_custom_fields"("workspace_id", "entity_type", "is_active", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "crm_custom_fields_workspace_id_entity_type_code_key" ON "crm_custom_fields"("workspace_id", "entity_type", "code");

-- CreateIndex
CREATE INDEX "crm_custom_field_options_workspace_id_field_id_is_active_so_idx" ON "crm_custom_field_options"("workspace_id", "field_id", "is_active", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "crm_custom_field_options_field_id_code_key" ON "crm_custom_field_options"("field_id", "code");

-- CreateIndex
CREATE INDEX "crm_custom_field_values_workspace_id_entity_type_entity_id__idx" ON "crm_custom_field_values"("workspace_id", "entity_type", "entity_id", "field_id");

-- CreateIndex
CREATE INDEX "crm_custom_field_values_workspace_id_field_id_idx" ON "crm_custom_field_values"("workspace_id", "field_id");

-- CreateIndex
CREATE UNIQUE INDEX "crm_custom_field_values_field_id_entity_type_entity_id_ordi_key" ON "crm_custom_field_values"("field_id", "entity_type", "entity_id", "ordinal");

-- CreateIndex
CREATE INDEX "crm_field_visibility_rules_workspace_id_field_id_idx" ON "crm_field_visibility_rules"("workspace_id", "field_id");

-- CreateIndex
CREATE UNIQUE INDEX "crm_field_visibility_rules_field_id_subject_type_subject_id_key" ON "crm_field_visibility_rules"("field_id", "subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "crm_field_requirements_workspace_id_entity_type_is_active_p_idx" ON "crm_field_requirements"("workspace_id", "entity_type", "is_active", "pipeline_id", "stage_id");

-- CreateIndex
CREATE INDEX "crm_field_requirements_workspace_id_target_custom_field_id_idx" ON "crm_field_requirements"("workspace_id", "target_custom_field_id");

-- CreateIndex
CREATE INDEX "crm_custom_field_migrations_workspace_id_field_id_idx" ON "crm_custom_field_migrations"("workspace_id", "field_id");

-- CreateIndex
CREATE UNIQUE INDEX "crm_field_schema_versions_workspace_id_entity_type_key" ON "crm_field_schema_versions"("workspace_id", "entity_type");

-- CreateIndex
CREATE UNIQUE INDEX "crm_activity_types_workspace_id_code_key" ON "crm_activity_types"("workspace_id", "code");

-- CreateIndex
CREATE INDEX "crm_activities_workspace_id_responsible_user_id_status_dead_idx" ON "crm_activities"("workspace_id", "responsible_user_id", "status", "deadline");

-- CreateIndex
CREATE INDEX "crm_activities_workspace_id_is_deleted_status_idx" ON "crm_activities"("workspace_id", "is_deleted", "status");

-- CreateIndex
CREATE INDEX "crm_activities_workspace_id_type_code_idx" ON "crm_activities"("workspace_id", "type_code");

-- CreateIndex
CREATE UNIQUE INDEX "crm_activities_workspace_id_external_origin_external_id_key" ON "crm_activities"("workspace_id", "external_origin", "external_id");

-- CreateIndex
CREATE INDEX "crm_activity_bindings_workspace_id_entity_type_entity_id_idx" ON "crm_activity_bindings"("workspace_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "crm_activity_bindings_activity_id_idx" ON "crm_activity_bindings"("activity_id");

-- CreateIndex
CREATE UNIQUE INDEX "crm_activity_bindings_activity_id_entity_type_entity_id_key" ON "crm_activity_bindings"("activity_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "crm_activity_participants_workspace_id_user_id_idx" ON "crm_activity_participants"("workspace_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "crm_activity_participants_activity_id_user_id_role_key" ON "crm_activity_participants"("activity_id", "user_id", "role");

-- CreateIndex
CREATE INDEX "crm_activity_communications_workspace_id_activity_id_idx" ON "crm_activity_communications"("workspace_id", "activity_id");

-- CreateIndex
CREATE INDEX "crm_activity_reminders_status_scheduled_for_idx" ON "crm_activity_reminders"("status", "scheduled_for");

-- CreateIndex
CREATE INDEX "crm_activity_reminders_workspace_id_activity_id_idx" ON "crm_activity_reminders"("workspace_id", "activity_id");

-- CreateIndex
CREATE UNIQUE INDEX "crm_activity_reminders_workspace_id_occurrence_key_key" ON "crm_activity_reminders"("workspace_id", "occurrence_key");

-- CreateIndex
CREATE UNIQUE INDEX "crm_activity_reminder_recipients_reminder_id_user_id_key" ON "crm_activity_reminder_recipients"("reminder_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "crm_activity_overdue_occurrences_activity_id_deadline_versi_key" ON "crm_activity_overdue_occurrences"("activity_id", "deadline_version");

-- CreateIndex
CREATE INDEX "crm_timeline_entries_workspace_id_entity_type_entity_id_occ_idx" ON "crm_timeline_entries"("workspace_id", "entity_type", "entity_id", "occurred_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "crm_timeline_entries_workspace_id_entity_type_entity_id_sou_key" ON "crm_timeline_entries"("workspace_id", "entity_type", "entity_id", "source_event_id", "projection_kind");

-- CreateIndex
CREATE INDEX "crm_timeline_comments_workspace_id_entity_type_entity_id_cr_idx" ON "crm_timeline_comments"("workspace_id", "entity_type", "entity_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "crm_timeline_comment_mentions_comment_id_user_id_key" ON "crm_timeline_comment_mentions"("comment_id", "user_id");

-- CreateIndex
CREATE INDEX "outbox_events_projected_at_occurred_at_idx" ON "outbox_events"("projected_at", "occurred_at");

-- RenameIndex
ALTER INDEX "crm_company_communications_workspace_id_type_normalized_value_i" RENAME TO "crm_company_communications_workspace_id_type_normalized_val_idx";

-- RenameIndex
ALTER INDEX "crm_contact_communications_workspace_id_type_normalized_value_i" RENAME TO "crm_contact_communications_workspace_id_type_normalized_val_idx";

-- RenameIndex
ALTER INDEX "crm_pipelines_workspace_id_entity_type_normalized_name_is_activ" RENAME TO "crm_pipelines_workspace_id_entity_type_normalized_name_is_a_key";

-- RenameIndex
ALTER INDEX "crm_record_observers_workspace_id_entity_type_record_id_user_id" RENAME TO "crm_record_observers_workspace_id_entity_type_record_id_use_key";

-- RenameIndex
ALTER INDEX "crm_stage_history_workspace_id_entity_type_record_id_moved_at_i" RENAME TO "crm_stage_history_workspace_id_entity_type_record_id_moved__idx";

-- RenameIndex
ALTER INDEX "crm_stage_transitions_pipeline_id_from_stage_id_to_stage_id_is_" RENAME TO "crm_stage_transitions_pipeline_id_from_stage_id_to_stage_id_key";

-- RenameIndex
ALTER INDEX "idempotency_records_workspace_id_actor_user_id_operation_idempo" RENAME TO "idempotency_records_workspace_id_actor_user_id_operation_id_key";
