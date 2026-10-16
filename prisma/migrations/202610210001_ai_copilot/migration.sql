-- CreateTable
CREATE TABLE "ai_providers" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "adapter_version" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ai_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_provider_connections" (
    "id" UUID NOT NULL,
    "workspace_id" UUID,
    "provider_id" UUID NOT NULL,
    "owner_scope" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "vault_secret_ref" TEXT,
    "secret_sealed" TEXT,
    "secret_fingerprint" TEXT,
    "endpoint" TEXT,
    "region" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "allowed_classifications" JSONB NOT NULL DEFAULT '["PUBLIC","INTERNAL"]',
    "cost_responsibility" TEXT NOT NULL,
    "verified_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_provider_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_models" (
    "id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "model_key" TEXT NOT NULL,
    "capabilities" JSONB NOT NULL,
    "context_limit" INTEGER NOT NULL,
    "input_rate" DECIMAL(20,8) NOT NULL,
    "output_rate" DECIMAL(20,8) NOT NULL,
    "rate_currency" TEXT NOT NULL,
    "catalog_version" INTEGER NOT NULL DEFAULT 1,
    "regions" JSONB NOT NULL DEFAULT '[]',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_routes" (
    "id" UUID NOT NULL,
    "workspace_id" UUID,
    "scenario_code" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "provider_connection_id" UUID NOT NULL,
    "model_id" UUID NOT NULL,
    "fallback_rules" JSONB NOT NULL DEFAULT '[]',
    "allowed_regions" JSONB NOT NULL DEFAULT '[]',
    "allowed_classifications" JSONB NOT NULL DEFAULT '["PUBLIC","INTERNAL"]',
    "max_cost" DECIMAL(20,6),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_routes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_workspace_settings" (
    "workspace_id" UUID NOT NULL,
    "module_enabled" BOOLEAN NOT NULL DEFAULT false,
    "scenario_settings" JSONB NOT NULL DEFAULT '{}',
    "classification_rules" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_workspace_settings_pkey" PRIMARY KEY ("workspace_id")
);

-- CreateTable
CREATE TABLE "ai_prompt_templates" (
    "id" UUID NOT NULL,
    "scenario_code" TEXT NOT NULL,
    "scope_key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "immutable_content" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "created_by" UUID NOT NULL,
    "published_by" UUID,
    "published_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_prompt_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_roles" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "behavior_instructions" TEXT NOT NULL,
    "guardrails" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_assistants" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "prompt_version_id" UUID,
    "allowed_scenarios" JSONB NOT NULL,
    "allowed_tools" JSONB NOT NULL DEFAULT '[]',
    "retrieval_profile_id" UUID,
    "behavior_role_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_assistants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_conversations" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "assistant_id" UUID,
    "classification" TEXT NOT NULL DEFAULT 'INTERNAL',
    "retention_days" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "deletion_state" TEXT,
    "no_history" BOOLEAN NOT NULL DEFAULT false,
    "title" TEXT NOT NULL DEFAULT '',
    "last_message_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_messages" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "sender" TEXT NOT NULL,
    "body_encrypted_or_ref" TEXT,
    "redaction_state" TEXT NOT NULL DEFAULT 'STORED',
    "model_run_id" UUID,
    "client_message_key" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_context_snapshots" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "authorized_source_hashes" JSONB NOT NULL,
    "model_request_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ai_context_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_retrieval_profiles" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "source_types" JSONB NOT NULL,
    "filter_policy" JSONB NOT NULL DEFAULT '{}',
    "max_chunks" INTEGER NOT NULL DEFAULT 5,
    "max_tokens" INTEGER NOT NULL DEFAULT 2000,
    "citation_required" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_retrieval_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_retrieval_runs" (
    "id" UUID NOT NULL,
    "ai_run_id" UUID NOT NULL,
    "profile_id" UUID,
    "query_hash" TEXT NOT NULL,
    "acl_version" INTEGER NOT NULL,
    "result_count" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'EMITTED',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_retrieval_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_source_citations" (
    "id" UUID NOT NULL,
    "ai_run_id" UUID NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "source_version" TEXT NOT NULL,
    "anchor" TEXT,
    "excerpt_hash" TEXT NOT NULL,
    "visibility_snapshot_version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_source_citations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_tool_policies" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "scenario_id" TEXT NOT NULL DEFAULT '*',
    "tool_code" TEXT NOT NULL,
    "role_scope" TEXT,
    "consent_mode" TEXT NOT NULL,
    "max_scope" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "ai_tool_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_tool_grants" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "tool_code" TEXT NOT NULL,
    "scope_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_tool_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_tool_calls" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "call_index" INTEGER NOT NULL,
    "tool_code" TEXT NOT NULL,
    "tool_version" INTEGER NOT NULL,
    "arguments_sealed" TEXT NOT NULL,
    "validated_args_hash" TEXT NOT NULL,
    "target_ref" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "decision_actor" UUID,
    "decision_mode" TEXT,
    "grant_id" UUID,
    "result" JSONB,
    "error_code" TEXT,
    "correlation_id" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "executed_at" TIMESTAMPTZ(6),

    CONSTRAINT "ai_tool_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_runs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "requester_id" UUID NOT NULL,
    "scenario_id" TEXT NOT NULL,
    "scenario_version" INTEGER NOT NULL,
    "prompt_version_id" UUID,
    "assistant_id" UUID,
    "conversation_id" UUID,
    "route_id" UUID,
    "model_route_version" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "classification" TEXT NOT NULL DEFAULT 'INTERNAL',
    "input_hash" TEXT NOT NULL,
    "input_sealed" TEXT,
    "output_sealed" TEXT,
    "output_valid" BOOLEAN,
    "idempotency_key" TEXT NOT NULL,
    "error_code" TEXT,
    "cost_mode" TEXT,
    "usage_reservation_id" UUID,
    "estimated_credits" DECIMAL(24,6) NOT NULL DEFAULT 0,
    "max_output_tokens" INTEGER NOT NULL DEFAULT 1024,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "cancel_requested_at" TIMESTAMPTZ(6),

    CONSTRAINT "ai_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_run_steps" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "step_kind" TEXT NOT NULL,
    "attempt_no" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "provider_request_id" TEXT,
    "model_id" UUID,
    "connection_id" UUID,
    "region" TEXT,
    "usage_reservation_id" UUID,
    "error_code" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_run_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_artifacts" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "file_id" UUID,
    "artifact_type" TEXT NOT NULL,
    "media_type" TEXT,
    "safety_state" TEXT NOT NULL,
    "review_state" TEXT NOT NULL DEFAULT 'DRAFT',
    "content_sealed" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_usage_records" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "step_id" UUID,
    "user_id" UUID NOT NULL,
    "scenario_code" TEXT NOT NULL,
    "model_id" UUID NOT NULL,
    "provider_connection_id" UUID NOT NULL,
    "cost_mode" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL,
    "output_tokens" INTEGER NOT NULL,
    "cached_tokens" INTEGER NOT NULL DEFAULT 0,
    "estimated" BOOLEAN NOT NULL DEFAULT false,
    "cost_amount" DECIMAL(20,8) NOT NULL,
    "cost_currency" TEXT NOT NULL,
    "credits" DECIMAL(24,6) NOT NULL,
    "pricing_version" INTEGER NOT NULL,
    "billing_event_key" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_workspace_budgets" (
    "workspace_id" UUID NOT NULL,
    "currency" TEXT NOT NULL,
    "soft_alert_amount" DECIMAL(20,4),
    "hard_cap_amount" DECIMAL(20,4),
    "reset_policy" TEXT NOT NULL DEFAULT 'MONTHLY',
    "alerted_period" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "ai_workspace_budgets_pkey" PRIMARY KEY ("workspace_id")
);

-- CreateTable
CREATE TABLE "ai_external_clients" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "client_type" TEXT NOT NULL,
    "public_client_id" TEXT NOT NULL,
    "secret_hash" TEXT NOT NULL,
    "redirect_uris" JSONB NOT NULL,
    "allowed_scenarios" JSONB NOT NULL DEFAULT '[]',
    "scopes" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_external_clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_external_auth_codes" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "code_challenge" TEXT NOT NULL,
    "redirect_uri" TEXT NOT NULL,
    "scopes" JSONB NOT NULL,
    "tool_ids" JSONB NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),

    CONSTRAINT "ai_external_auth_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_external_grants" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "scopes" JSONB NOT NULL,
    "tool_ids" JSONB NOT NULL,
    "token_fingerprint" TEXT,
    "refresh_fingerprint" TEXT,
    "access_expires_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_external_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_external_sessions" (
    "id" UUID NOT NULL,
    "grant_id" UUID NOT NULL,
    "capability_hash" TEXT NOT NULL,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "ai_external_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_evaluations" (
    "id" UUID NOT NULL,
    "workspace_id" UUID,
    "scenario_id" TEXT NOT NULL,
    "route_id" UUID,
    "model_id" UUID,
    "suite_id" TEXT NOT NULL,
    "benchmark_version" INTEGER NOT NULL,
    "rubric_version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "score_json" JSONB NOT NULL DEFAULT '{}',
    "requested_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "ai_evaluations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_feedback" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "submitted_by" UUID NOT NULL,
    "rating" INTEGER NOT NULL,
    "issue_tags" JSONB NOT NULL DEFAULT '[]',
    "redacted_comment" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_security_findings" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "run_id" UUID,
    "category" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "details" JSONB NOT NULL DEFAULT '{}',
    "decision" TEXT,
    "reason" TEXT,
    "resolved_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),

    CONSTRAINT "ai_security_findings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_policy_versions" (
    "id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "classification_rules_json" JSONB NOT NULL,
    "active_from" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,

    CONSTRAINT "ai_policy_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_transcripts" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "source_file_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "scenario_id" TEXT NOT NULL,
    "language" TEXT,
    "diarization_meta" JSONB,
    "text_sealed" TEXT,
    "review_status" TEXT NOT NULL DEFAULT 'UNREVIEWED',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_transcripts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_extractions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "source_ref" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT,
    "schema_version" INTEGER NOT NULL,
    "proposed_fields_json" JSONB NOT NULL,
    "validation_status" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PROPOSED',
    "created_by" UUID NOT NULL,
    "applied_by" UUID,
    "applied_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_extractions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_providers_code_key" ON "ai_providers"("code");

-- CreateIndex
CREATE INDEX "ai_provider_connections_workspace_id_status_idx" ON "ai_provider_connections"("workspace_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ai_models_provider_id_model_key_catalog_version_key" ON "ai_models"("provider_id", "model_key", "catalog_version");

-- CreateIndex
CREATE INDEX "ai_routes_workspace_id_scenario_code_priority_idx" ON "ai_routes"("workspace_id", "scenario_code", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "ai_prompt_templates_scenario_code_scope_key_version_key" ON "ai_prompt_templates"("scenario_code", "scope_key", "version");

-- CreateIndex
CREATE INDEX "ai_assistants_workspace_id_status_idx" ON "ai_assistants"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "ai_conversations_workspace_id_owner_user_id_status_idx" ON "ai_conversations"("workspace_id", "owner_user_id", "status");

-- CreateIndex
CREATE INDEX "ai_messages_conversation_id_occurred_at_id_idx" ON "ai_messages"("conversation_id", "occurred_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_messages_conversation_id_client_message_key_key" ON "ai_messages"("conversation_id", "client_message_key");

-- CreateIndex
CREATE UNIQUE INDEX "ai_context_snapshots_run_id_key" ON "ai_context_snapshots"("run_id");

-- CreateIndex
CREATE INDEX "ai_retrieval_runs_ai_run_id_idx" ON "ai_retrieval_runs"("ai_run_id");

-- CreateIndex
CREATE INDEX "ai_source_citations_ai_run_id_idx" ON "ai_source_citations"("ai_run_id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_tool_policies_workspace_id_scenario_id_tool_code_key" ON "ai_tool_policies"("workspace_id", "scenario_id", "tool_code");

-- CreateIndex
CREATE INDEX "ai_tool_grants_workspace_id_user_id_tool_code_idx" ON "ai_tool_grants"("workspace_id", "user_id", "tool_code");

-- CreateIndex
CREATE INDEX "ai_tool_calls_workspace_id_status_idx" ON "ai_tool_calls"("workspace_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ai_tool_calls_run_id_call_index_key" ON "ai_tool_calls"("run_id", "call_index");

-- CreateIndex
CREATE INDEX "ai_runs_workspace_id_requester_id_status_idx" ON "ai_runs"("workspace_id", "requester_id", "status");

-- CreateIndex
CREATE INDEX "ai_runs_status_created_at_idx" ON "ai_runs"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ai_runs_workspace_id_requester_id_scenario_id_idempotency_k_key" ON "ai_runs"("workspace_id", "requester_id", "scenario_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "ai_run_steps_run_id_attempt_no_idx" ON "ai_run_steps"("run_id", "attempt_no");

-- CreateIndex
CREATE INDEX "ai_artifacts_run_id_idx" ON "ai_artifacts"("run_id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_usage_records_billing_event_key_key" ON "ai_usage_records"("billing_event_key");

-- CreateIndex
CREATE INDEX "ai_usage_records_workspace_id_occurred_at_idx" ON "ai_usage_records"("workspace_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "ai_external_clients_public_client_id_key" ON "ai_external_clients"("public_client_id");

-- CreateIndex
CREATE INDEX "ai_external_clients_workspace_id_status_idx" ON "ai_external_clients"("workspace_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ai_external_auth_codes_code_hash_key" ON "ai_external_auth_codes"("code_hash");

-- CreateIndex
CREATE UNIQUE INDEX "ai_external_grants_token_fingerprint_key" ON "ai_external_grants"("token_fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "ai_external_grants_refresh_fingerprint_key" ON "ai_external_grants"("refresh_fingerprint");

-- CreateIndex
CREATE INDEX "ai_external_grants_workspace_id_user_id_idx" ON "ai_external_grants"("workspace_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_external_sessions_grant_id_capability_hash_key" ON "ai_external_sessions"("grant_id", "capability_hash");

-- CreateIndex
CREATE INDEX "ai_evaluations_workspace_id_scenario_id_idx" ON "ai_evaluations"("workspace_id", "scenario_id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_feedback_run_id_submitted_by_key" ON "ai_feedback"("run_id", "submitted_by");

-- CreateIndex
CREATE INDEX "ai_security_findings_workspace_id_status_idx" ON "ai_security_findings"("workspace_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ai_policy_versions_scope_version_key" ON "ai_policy_versions"("scope", "version");

-- CreateIndex
CREATE INDEX "ai_transcripts_workspace_id_source_file_id_idx" ON "ai_transcripts"("workspace_id", "source_file_id");

-- CreateIndex
CREATE INDEX "ai_extractions_workspace_id_state_idx" ON "ai_extractions"("workspace_id", "state");


-- ---------------------------------------------------------------------------------------------
-- AI invariants and seed catalog.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "ai_feedback" ADD CONSTRAINT "ai_feedback_rating_range" CHECK ("rating" BETWEEN 1 AND 5);
ALTER TABLE "ai_usage_records" ADD CONSTRAINT "ai_usage_nonnegative" CHECK ("input_tokens" >= 0 AND "output_tokens" >= 0 AND "cached_tokens" >= 0 AND "cost_amount" >= 0 AND "credits" >= 0);
-- Usage evidence and policy history are append-only (pricing snapshots never rewritten, 07 AC05).
CREATE OR REPLACE FUNCTION ai_forbid_history_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AI_HISTORY_IMMUTABLE: % rows are append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER ai_usage_records_append_only BEFORE UPDATE OR DELETE ON "ai_usage_records" FOR EACH ROW EXECUTE FUNCTION ai_forbid_history_mutation();
CREATE TRIGGER ai_policy_versions_append_only BEFORE UPDATE OR DELETE ON "ai_policy_versions" FOR EACH ROW EXECUTE FUNCTION ai_forbid_history_mutation();
-- Published prompt versions are immutable (runs pin them).
CREATE OR REPLACE FUNCTION ai_forbid_published_prompt_edit() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'DRAFT' AND (NEW.immutable_content <> OLD.immutable_content OR NEW.content_hash <> OLD.content_hash OR NEW.version <> OLD.version) THEN
    RAISE EXCEPTION 'AI_PROMPT_IMMUTABLE: published prompt versions cannot be edited';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER ai_prompt_templates_immutable BEFORE UPDATE ON "ai_prompt_templates" FOR EACH ROW EXECUTE FUNCTION ai_forbid_published_prompt_edit();

INSERT INTO "ai_providers" ("id", "code", "name") VALUES
  (gen_random_uuid(), 'OPENAI', 'OpenAI'), (gen_random_uuid(), 'AZURE_OPENAI', 'Azure OpenAI'), (gen_random_uuid(), 'ANTHROPIC', 'Anthropic'),
  (gen_random_uuid(), 'GOOGLE_GEMINI', 'Google Gemini'), (gen_random_uuid(), 'OPENROUTER', 'OpenRouter')
ON CONFLICT ("code") DO NOTHING;
