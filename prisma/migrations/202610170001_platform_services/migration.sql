-- 30-Platform-Services (TrueCRM_Final_Modules_Codex_Pack): additive tables/columns only.
-- AlterTable
ALTER TABLE "user_notifications" ADD COLUMN     "archived_at" TIMESTAMPTZ(3),
ADD COLUMN     "mandatory" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'UNREAD',
ADD COLUMN     "subject_id" UUID,
ADD COLUMN     "subject_type" TEXT,
ADD COLUMN     "template_version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "topic" TEXT;

-- AlterTable
ALTER TABLE "notification_preferences" ADD COLUMN     "quiet_hours" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "outbox_events" ADD COLUMN     "aggregate_version" INTEGER,
ADD COLUMN     "publish_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "publish_lease_token" TEXT,
ADD COLUMN     "publish_lease_until" TIMESTAMPTZ(6),
ADD COLUMN     "publish_status" TEXT NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "published_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "suite_legal_holds" ADD COLUMN     "authority_ref" TEXT,
ADD COLUMN     "release_reason" TEXT,
ADD COLUMN     "released_by_user_id" UUID;

-- CreateTable
CREATE TABLE "platform_role_assignments" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "permissions" JSONB NOT NULL DEFAULT '[]',
    "mfa_required" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "platform_role_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_global_events" (
    "id" UUID NOT NULL,
    "audience" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "event_version" INTEGER NOT NULL DEFAULT 1,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "aggregate_version" INTEGER,
    "partner_id" UUID,
    "actor_type" TEXT NOT NULL DEFAULT 'USER',
    "actor_id" UUID,
    "payload" JSONB NOT NULL,
    "correlation_id" TEXT,
    "causation_id" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publish_status" TEXT NOT NULL DEFAULT 'PENDING',
    "publish_attempts" INTEGER NOT NULL DEFAULT 0,
    "publish_lease_token" TEXT,
    "publish_lease_until" TIMESTAMPTZ(6),
    "published_at" TIMESTAMPTZ(6),

    CONSTRAINT "platform_global_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_event_receipts" (
    "id" UUID NOT NULL,
    "consumer_id" TEXT NOT NULL,
    "event_id" UUID NOT NULL,
    "workspace_id" UUID,
    "handler_version" INTEGER NOT NULL DEFAULT 1,
    "result_hash" TEXT,
    "processed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_event_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_event_dead_letters" (
    "id" UUID NOT NULL,
    "consumer_id" TEXT NOT NULL,
    "event_id" UUID NOT NULL,
    "workspace_id" UUID,
    "failure_code" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "next_retry_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "replayed_at" TIMESTAMPTZ(6),
    "replayed_by" UUID,
    "replay_reason" TEXT,

    CONSTRAINT "platform_event_dead_letters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_jobs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID,
    "type" TEXT NOT NULL,
    "owner_module" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "idempotency_key" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "next_run_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_token" TEXT,
    "lease_until" TIMESTAMPTZ(6),
    "last_error_code" TEXT,
    "correlation_id" TEXT,
    "result" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_job_attempts" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "attempt_number" INTEGER NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "outcome" TEXT,
    "error_code" TEXT,
    "trace_ref" TEXT,
    "actor_user_id" UUID,

    CONSTRAINT "platform_job_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_schedules" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "owner_module" TEXT NOT NULL,
    "job_type" TEXT NOT NULL,
    "interval_minutes" INTEGER,
    "daily_local_time" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "dst_policy" TEXT NOT NULL DEFAULT 'SHIFT_FORWARD_FIRST_OCCURRENCE',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "last_occurrence_key" TEXT,
    "last_enqueued_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "platform_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_deliveries" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "notification_id" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "provider_message_id" TEXT,
    "dedupe_key" TEXT NOT NULL,
    "last_error_code" TEXT,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_provider_events" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_event_id" TEXT NOT NULL,
    "delivery_id" UUID,
    "status" TEXT NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_provider_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_registrations" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "platform" TEXT NOT NULL,
    "push_token_hash" TEXT NOT NULL,
    "push_token_sealed" TEXT NOT NULL,
    "last_verified_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "device_registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "search_documents" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "source_module" TEXT NOT NULL,
    "source_id" UUID NOT NULL,
    "source_version" INTEGER NOT NULL DEFAULT 1,
    "title" TEXT NOT NULL,
    "searchable_text" TEXT NOT NULL,
    "classification" TEXT NOT NULL DEFAULT 'INTERNAL',
    "acl_ref" TEXT,
    "state" TEXT NOT NULL DEFAULT 'INDEXED',
    "indexed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "search_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "search_reindex_jobs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "source_types" JSONB NOT NULL DEFAULT '[]',
    "state" TEXT NOT NULL DEFAULT 'QUEUED',
    "source_cursor" TEXT,
    "indexed" INTEGER NOT NULL DEFAULT 0,
    "withdrawn" INTEGER NOT NULL DEFAULT 0,
    "error_code" TEXT,
    "requested_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "search_reindex_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recent_items" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recent_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "favorites" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "favorites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_events" (
    "id" UUID NOT NULL,
    "workspace_id" UUID,
    "principal_id" UUID,
    "event_type" TEXT NOT NULL,
    "risk" TEXT NOT NULL DEFAULT 'LOW',
    "details" JSONB NOT NULL DEFAULT '{}',
    "request_id" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_access_grants" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "platform_user_id" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "scope" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "revoked_by" UUID,
    "revoked_at" TIMESTAMPTZ(6),
    "emergency" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "support_access_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "emergency_support_sessions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "platform_user_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "incident_ref" TEXT NOT NULL,
    "second_approver_id" UUID,
    "grant_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'PENDING_SECOND_APPROVAL',
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "reviewed_at" TIMESTAMPTZ(6),
    "reviewed_by" UUID,
    "review_note" TEXT,
    "customer_notified_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "emergency_support_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_settings" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "scope_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "value" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feature_flags" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "state" TEXT NOT NULL DEFAULT 'DISABLED',
    "rollout_policy" JSONB NOT NULL DEFAULT '{}',
    "target_scopes" JSONB NOT NULL DEFAULT '[]',
    "guard_permission" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "localization_preferences" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "date_format" TEXT NOT NULL DEFAULT 'YYYY-MM-DD',
    "rtl" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "localization_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "number_sequences" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "sequence_name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL DEFAULT '',
    "next_value" BIGINT NOT NULL DEFAULT 1,
    "pad_width" INTEGER NOT NULL DEFAULT 6,

    CONSTRAINT "number_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "number_allocations" (
    "id" UUID NOT NULL,
    "sequence_id" UUID NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "value" BIGINT NOT NULL,
    "formatted" TEXT NOT NULL,
    "allocated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "number_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_idempotency_keys" (
    "id" UUID NOT NULL,
    "scope_key" TEXT NOT NULL,
    "operation_code" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'IN_PROGRESS',
    "response" JSONB,
    "locked_until" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_limit_policies" (
    "id" UUID NOT NULL,
    "operation_code" TEXT NOT NULL,
    "principal_scope" TEXT NOT NULL,
    "requests" INTEGER NOT NULL,
    "window_seconds" INTEGER NOT NULL,
    "burst" INTEGER NOT NULL DEFAULT 0,
    "risk_class" TEXT NOT NULL DEFAULT 'STANDARD',
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_limit_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cache_versions" (
    "id" UUID NOT NULL,
    "namespace" TEXT NOT NULL,
    "scope_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "invalidated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cache_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "privacy_requests" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "subject_ref" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "reason" TEXT NOT NULL,
    "decision_reason" TEXT,
    "identity_verified_at" TIMESTAMPTZ(6),
    "requested_by" UUID NOT NULL,
    "reviewed_by" UUID,
    "output_sealed" TEXT,
    "output_expires_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "privacy_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "privacy_job_items" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "module_code" TEXT NOT NULL,
    "processed_count" INTEGER NOT NULL DEFAULT 0,
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "checkpoint" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "output" JSONB,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "privacy_job_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_retention_policies" (
    "id" UUID NOT NULL,
    "jurisdiction" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "duration_days" INTEGER,
    "action" TEXT NOT NULL,
    "legal_basis" TEXT NOT NULL,
    "effective_from" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_retention_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_health_snapshots" (
    "id" UUID NOT NULL,
    "component" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "availability" TEXT NOT NULL,
    "queue_lag" INTEGER NOT NULL DEFAULT 0,
    "outbox_lag" INTEGER NOT NULL DEFAULT 0,
    "search_lag" INTEGER NOT NULL DEFAULT 0,
    "provider_health" JSONB NOT NULL DEFAULT '{}',
    "observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_health_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recovery_plans" (
    "id" UUID NOT NULL,
    "environment" TEXT NOT NULL,
    "backup_profile_id" TEXT NOT NULL,
    "target_rpo_minutes" INTEGER NOT NULL,
    "target_rto_minutes" INTEGER NOT NULL,
    "procedure_ref" TEXT NOT NULL,
    "last_restore_test_at" TIMESTAMPTZ(6),
    "last_result" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "recovery_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restore_tests" (
    "id" UUID NOT NULL,
    "backup_id" TEXT NOT NULL,
    "isolated_environment" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "checks" JSONB NOT NULL DEFAULT '[]',
    "measured_rto_minutes" INTEGER,
    "requested_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "restore_tests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_rules" (
    "id" UUID NOT NULL,
    "metric" TEXT NOT NULL,
    "threshold" INTEGER NOT NULL,
    "escalation_target" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "alert_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_alerts" (
    "id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "metric" TEXT NOT NULL,
    "observed_value" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'OPEN',
    "opened_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledged_by" UUID,
    "acknowledged_at" TIMESTAMPTZ(6),
    "resolved_at" TIMESTAMPTZ(6),

    CONSTRAINT "platform_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_role_assignments_user_id_key" ON "platform_role_assignments"("user_id");

-- CreateIndex
CREATE INDEX "platform_global_events_publish_status_occurred_at_idx" ON "platform_global_events"("publish_status", "occurred_at");

-- CreateIndex
CREATE INDEX "platform_global_events_aggregate_type_aggregate_id_aggregat_idx" ON "platform_global_events"("aggregate_type", "aggregate_id", "aggregate_version");

-- CreateIndex
CREATE INDEX "platform_event_receipts_event_id_idx" ON "platform_event_receipts"("event_id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_event_receipts_consumer_id_event_id_key" ON "platform_event_receipts"("consumer_id", "event_id");

-- CreateIndex
CREATE INDEX "platform_event_dead_letters_status_next_retry_at_idx" ON "platform_event_dead_letters"("status", "next_retry_at");

-- CreateIndex
CREATE UNIQUE INDEX "platform_event_dead_letters_consumer_id_event_id_key" ON "platform_event_dead_letters"("consumer_id", "event_id");

-- CreateIndex
CREATE INDEX "platform_jobs_state_next_run_at_idx" ON "platform_jobs"("state", "next_run_at");

-- CreateIndex
CREATE INDEX "platform_jobs_workspace_id_state_idx" ON "platform_jobs"("workspace_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "platform_jobs_type_idempotency_key_key" ON "platform_jobs"("type", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "platform_job_attempts_job_id_attempt_number_key" ON "platform_job_attempts"("job_id", "attempt_number");

-- CreateIndex
CREATE UNIQUE INDEX "platform_schedules_name_key" ON "platform_schedules"("name");

-- CreateIndex
CREATE UNIQUE INDEX "notification_deliveries_dedupe_key_key" ON "notification_deliveries"("dedupe_key");

-- CreateIndex
CREATE INDEX "notification_deliveries_status_next_attempt_at_idx" ON "notification_deliveries"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "notification_deliveries_notification_id_idx" ON "notification_deliveries"("notification_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_provider_events_provider_provider_event_id_key" ON "notification_provider_events"("provider", "provider_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "device_registrations_workspace_id_user_id_push_token_hash_key" ON "device_registrations"("workspace_id", "user_id", "push_token_hash");

-- CreateIndex
CREATE INDEX "search_documents_workspace_id_state_idx" ON "search_documents"("workspace_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "search_documents_workspace_id_source_module_source_id_key" ON "search_documents"("workspace_id", "source_module", "source_id");

-- CreateIndex
CREATE INDEX "recent_items_workspace_id_user_id_last_seen_at_idx" ON "recent_items"("workspace_id", "user_id", "last_seen_at");

-- CreateIndex
CREATE UNIQUE INDEX "recent_items_workspace_id_user_id_entity_type_entity_id_key" ON "recent_items"("workspace_id", "user_id", "entity_type", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "favorites_workspace_id_user_id_entity_type_entity_id_key" ON "favorites"("workspace_id", "user_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "security_events_workspace_id_occurred_at_idx" ON "security_events"("workspace_id", "occurred_at");

-- CreateIndex
CREATE INDEX "security_events_event_type_occurred_at_idx" ON "security_events"("event_type", "occurred_at");

-- CreateIndex
CREATE INDEX "support_access_grants_workspace_id_platform_user_id_status_idx" ON "support_access_grants"("workspace_id", "platform_user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "platform_settings_key_scope_scope_id_key" ON "platform_settings"("key", "scope", "scope_id");

-- CreateIndex
CREATE UNIQUE INDEX "feature_flags_name_key" ON "feature_flags"("name");

-- CreateIndex
CREATE UNIQUE INDEX "localization_preferences_user_id_workspace_id_key" ON "localization_preferences"("user_id", "workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "number_sequences_workspace_id_entity_type_sequence_name_key" ON "number_sequences"("workspace_id", "entity_type", "sequence_name");

-- CreateIndex
CREATE UNIQUE INDEX "number_allocations_sequence_id_idempotency_key_key" ON "number_allocations"("sequence_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "platform_idempotency_keys_scope_key_operation_code_key_hash_key" ON "platform_idempotency_keys"("scope_key", "operation_code", "key_hash");

-- CreateIndex
CREATE UNIQUE INDEX "rate_limit_policies_operation_code_principal_scope_key" ON "rate_limit_policies"("operation_code", "principal_scope");

-- CreateIndex
CREATE UNIQUE INDEX "cache_versions_namespace_scope_id_key" ON "cache_versions"("namespace", "scope_id");

-- CreateIndex
CREATE INDEX "privacy_requests_workspace_id_status_idx" ON "privacy_requests"("workspace_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "privacy_job_items_request_id_module_code_key" ON "privacy_job_items"("request_id", "module_code");

-- CreateIndex
CREATE UNIQUE INDEX "platform_retention_policies_jurisdiction_category_effective_key" ON "platform_retention_policies"("jurisdiction", "category", "effective_from");

-- CreateIndex
CREATE INDEX "service_health_snapshots_component_observed_at_idx" ON "service_health_snapshots"("component", "observed_at");

-- CreateIndex
CREATE UNIQUE INDEX "recovery_plans_environment_key" ON "recovery_plans"("environment");

-- CreateIndex
CREATE UNIQUE INDEX "alert_rules_metric_key" ON "alert_rules"("metric");

-- CreateIndex
CREATE INDEX "platform_alerts_state_metric_idx" ON "platform_alerts"("state", "metric");

-- CreateIndex
CREATE INDEX "outbox_events_publish_status_occurred_at_idx" ON "outbox_events"("publish_status", "occurred_at");


-- Historical outbox rows were already consumed by existing projectors; the new dispatcher starts from new events.
UPDATE "outbox_events" SET "publish_status" = 'PUBLISHED', "published_at" = COALESCE("projected_at", "occurred_at") WHERE "publish_status" = 'PENDING';
UPDATE "user_notifications" SET "status" = 'READ' WHERE "read_at" IS NOT NULL;

-- Audit and security history are append-only: no API or SQL path may rewrite or delete them.
CREATE OR REPLACE FUNCTION platform_forbid_history_mutation() RETURNS trigger AS $$
BEGIN
  -- Only referential SET NULL (owner hard-delete) may touch existing rows; content never changes.
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'audit_logs'
     AND (to_jsonb(NEW) - 'workspace_id' - 'partner_id' - 'actor_user_id') = (to_jsonb(OLD) - 'workspace_id' - 'partner_id' - 'actor_user_id')
     AND (NEW.workspace_id IS NULL OR NEW.workspace_id = OLD.workspace_id)
     AND (NEW.partner_id IS NULL OR NEW.partner_id = OLD.partner_id)
     AND (NEW.actor_user_id IS NULL OR NEW.actor_user_id = OLD.actor_user_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'AUDIT_IMMUTABLE: % rows are append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS audit_logs_append_only ON "audit_logs";
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON "audit_logs" FOR EACH ROW EXECUTE FUNCTION platform_forbid_history_mutation();
DROP TRIGGER IF EXISTS security_events_append_only ON "security_events";
CREATE TRIGGER security_events_append_only BEFORE UPDATE OR DELETE ON "security_events" FOR EACH ROW EXECUTE FUNCTION platform_forbid_history_mutation();
