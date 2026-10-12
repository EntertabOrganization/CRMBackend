-- CreateTable
CREATE TABLE "spa_schema_migration_jobs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "type_id" UUID NOT NULL,
    "field_id" UUID NOT NULL,
    "old_version" INTEGER NOT NULL,
    "new_draft_id" UUID NOT NULL,
    "draft_version" INTEGER NOT NULL,
    "target_type" TEXT NOT NULL,
    "field_mapping_json" JSONB NOT NULL,
    "conversion_failures" JSONB NOT NULL DEFAULT '[]',
    "processed_count" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "created_by_user_id" UUID NOT NULL,
    "claim_token" UUID,
    "lease_expires_at" TIMESTAMPTZ(6),
    "correlation_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "applied_at" TIMESTAMPTZ(6),

    CONSTRAINT "spa_schema_migration_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spa_schema_migration_values" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "source_hash" TEXT NOT NULL,
    "source_item_version" INTEGER NOT NULL,
    "original_value" JSONB NOT NULL,
    "converted_value" JSONB NOT NULL,

    CONSTRAINT "spa_schema_migration_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spa_recurrence_rules" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "type_id" UUID NOT NULL,
    "frequency" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6),
    "interval" INTEGER NOT NULL DEFAULT 1,
    "by_day_json" JSONB NOT NULL DEFAULT '[]',
    "max_instances" INTEGER,
    "custom_rule" TEXT,
    "item_payload_json" JSONB NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "next_scheduled_for" TIMESTAMPTZ(6),
    "next_retry_at" TIMESTAMPTZ(6),
    "last_error_code" TEXT,
    "failure_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spa_recurrence_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spa_recurrence_instances" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "scheduled_for" TIMESTAMPTZ(6) NOT NULL,
    "item_id" UUID NOT NULL,
    "rule_version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spa_recurrence_instances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "spa_schema_migration_jobs_status_created_at_idx" ON "spa_schema_migration_jobs"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "spa_schema_migration_jobs_workspace_id_id_key" ON "spa_schema_migration_jobs"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "spa_schema_migration_values_workspace_id_job_id_item_id_key" ON "spa_schema_migration_values"("workspace_id", "job_id", "item_id");

-- CreateIndex
CREATE INDEX "spa_recurrence_rules_is_active_next_scheduled_for_idx" ON "spa_recurrence_rules"("is_active", "next_scheduled_for");

-- CreateIndex
CREATE UNIQUE INDEX "spa_recurrence_rules_workspace_id_id_key" ON "spa_recurrence_rules"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "spa_recurrence_instances_workspace_id_rule_id_scheduled_for_key" ON "spa_recurrence_instances"("workspace_id", "rule_id", "scheduled_for");

ALTER TABLE spa_schema_migration_jobs
  ADD CONSTRAINT spa_migration_type_fk FOREIGN KEY (workspace_id,type_id) REFERENCES spa_entity_types(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT spa_migration_field_fk FOREIGN KEY (workspace_id,type_id,field_id) REFERENCES spa_field_definitions(workspace_id,type_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT spa_migration_draft_fk FOREIGN KEY (workspace_id,new_draft_id) REFERENCES spa_schema_drafts(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT spa_migration_actor_fk FOREIGN KEY (workspace_id,created_by_user_id) REFERENCES workspace_memberships(workspace_id,user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT spa_migration_status_check CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED') AND processed_count >= 0 AND draft_version > 0);
ALTER TABLE spa_schema_migration_values
  ADD CONSTRAINT spa_conversion_job_fk FOREIGN KEY (workspace_id,job_id) REFERENCES spa_schema_migration_jobs(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT spa_conversion_item_fk FOREIGN KEY (workspace_id,item_id) REFERENCES spa_items(workspace_id,id) ON DELETE RESTRICT;
ALTER TABLE spa_recurrence_rules
  ADD CONSTRAINT spa_recurrence_type_fk FOREIGN KEY (workspace_id,type_id) REFERENCES spa_entity_types(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT spa_recurrence_actor_fk FOREIGN KEY (workspace_id,created_by_user_id) REFERENCES workspace_memberships(workspace_id,user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT spa_recurrence_check CHECK (frequency IN ('DAILY','WEEKLY','MONTHLY','YEARLY','CUSTOM') AND interval > 0 AND version > 0 AND (ends_at IS NULL OR ends_at >= starts_at) AND (max_instances IS NULL OR max_instances > 0));
ALTER TABLE spa_recurrence_instances
  ADD CONSTRAINT spa_occurrence_rule_fk FOREIGN KEY (workspace_id,rule_id) REFERENCES spa_recurrence_rules(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT spa_occurrence_item_fk FOREIGN KEY (workspace_id,item_id) REFERENCES spa_items(workspace_id,id) ON DELETE RESTRICT;
CREATE TRIGGER spa_occurrence_immutable BEFORE UPDATE OR DELETE ON spa_recurrence_instances FOR EACH ROW EXECUTE FUNCTION spa_reject_history_change();
