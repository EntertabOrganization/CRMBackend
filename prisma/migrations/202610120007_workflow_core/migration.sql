-- CreateTable
CREATE TABLE "workflow_definitions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "bound_entity_type" TEXT NOT NULL,
    "bound_entity_type_id" UUID,
    "current_version_id" UUID,
    "concurrency_mode" TEXT NOT NULL DEFAULT 'ONE_PER_DEFINITION_PER_ENTITY',
    "run_as" TEXT NOT NULL DEFAULT 'STARTER',
    "service_account_user_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_versions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "definition_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "definition_json" JSONB NOT NULL DEFAULT '{}',
    "checksum" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "published_at" TIMESTAMPTZ(6),
    "published_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_nodes" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "node_key" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "configuration_json" JSONB NOT NULL,
    "position_x" DOUBLE PRECISION NOT NULL,
    "position_y" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "workflow_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_edges" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "from_node_id" UUID NOT NULL,
    "to_node_id" UUID NOT NULL,
    "edge_type" TEXT NOT NULL,
    "condition_json" JSONB,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "workflow_edges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_triggers" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "definition_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "configuration_json" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "next_scheduled_at" TIMESTAMPTZ(6),

    CONSTRAINT "workflow_triggers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_runtime_policies" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "max_loop_iterations" INTEGER NOT NULL DEFAULT 1000,
    "max_node_runs" INTEGER NOT NULL DEFAULT 10000,
    "max_depth" INTEGER NOT NULL DEFAULT 10,
    "max_lifetime_days" INTEGER NOT NULL DEFAULT 365,
    "max_concurrent_executions" INTEGER NOT NULL DEFAULT 100,
    "retention_days" INTEGER NOT NULL DEFAULT 365,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "workflow_runtime_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_executions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "definition_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "snapshot" JSONB NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "run_as" TEXT NOT NULL,
    "concurrency_mode" TEXT NOT NULL,
    "concurrency_key" TEXT,
    "execution_user_id" UUID NOT NULL,
    "started_by_type" TEXT NOT NULL DEFAULT 'USER',
    "started_by_id" UUID NOT NULL,
    "parameters" JSONB NOT NULL,
    "variables" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "result_code" TEXT,
    "result_json" JSONB,
    "parent_execution_id" UUID,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "ancestry" JSONB NOT NULL DEFAULT '[]',
    "legal_hold" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "workflow_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_entity_locks" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "lock_scope" TEXT NOT NULL,
    "execution_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "leased_by" UUID,

    CONSTRAINT "workflow_entity_locks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_execution_tokens" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "execution_id" UUID NOT NULL,
    "branch_key" TEXT NOT NULL,
    "node_key" TEXT NOT NULL,
    "activation_key" TEXT NOT NULL,
    "iteration_number" INTEGER NOT NULL DEFAULT 0,
    "loop_state" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'READY',
    "join_group_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_execution_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_node_executions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "execution_id" UUID NOT NULL,
    "token_id" UUID NOT NULL,
    "node_id" UUID NOT NULL,
    "iteration_number" INTEGER NOT NULL,
    "activation_key" TEXT NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "input_json" JSONB NOT NULL DEFAULT '{}',
    "output_json" JSONB,
    "error_code" TEXT,
    "lease_owner" UUID,
    "lease_until" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "workflow_node_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_execution_logs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "execution_id" UUID NOT NULL,
    "node_run_id" UUID,
    "level" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "classification" TEXT NOT NULL DEFAULT 'PUBLIC',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_execution_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_human_assignments" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "execution_id" UUID NOT NULL,
    "node_run_id" UUID NOT NULL,
    "assignment_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "policy" TEXT NOT NULL DEFAULT 'ALL',
    "quorum_count" INTEGER,
    "reject_policy" TEXT NOT NULL DEFAULT 'ANY_REJECT',
    "information_schema" JSONB NOT NULL DEFAULT '[]',
    "due_at" TIMESTAMPTZ(6),
    "timeout_policy" JSONB NOT NULL DEFAULT '{"type":"TIMEOUT_BRANCH"}',
    "result_json" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_human_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_assignment_participants" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "assignment_id" UUID NOT NULL,
    "original_user_id" UUID NOT NULL,
    "effective_user_id" UUID NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "workflow_assignment_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_approval_votes" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "assignment_id" UUID NOT NULL,
    "participant_id" UUID NOT NULL,
    "assignee_user_id" UUID NOT NULL,
    "acted_by_user_id" UUID NOT NULL,
    "decision" TEXT NOT NULL,
    "comment" TEXT,
    "fields_json" JSONB,
    "decided_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_approval_votes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_assignment_history" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "assignment_id" UUID NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "metadata" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_assignment_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_timers" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "execution_id" UUID NOT NULL,
    "node_run_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "scheduled_for" TIMESTAMPTZ(6) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "remaining_seconds" INTEGER,
    "unique_resume_key" TEXT NOT NULL,

    CONSTRAINT "workflow_timers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_event_subscriptions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "execution_id" UUID NOT NULL,
    "node_run_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "correlation_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMPTZ(6),
    "fulfilled_by_event_id" UUID,

    CONSTRAINT "workflow_event_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_parallel_joins" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "execution_id" UUID NOT NULL,
    "split_activation_key" TEXT NOT NULL,
    "join_node_key" TEXT NOT NULL,
    "join_mode" TEXT NOT NULL,
    "required_count" INTEGER NOT NULL,
    "branches" JSONB NOT NULL,
    "completed_branch_tokens" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'PENDING',

    CONSTRAINT "workflow_parallel_joins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_child_executions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "parent_execution_id" UUID NOT NULL,
    "child_execution_id" UUID NOT NULL,
    "parent_node_run_id" UUID NOT NULL,
    "wait_for_completion" BOOLEAN NOT NULL,
    "result_mapping_json" JSONB NOT NULL,
    "resumed_at" TIMESTAMPTZ(6),

    CONSTRAINT "workflow_child_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_compensation_actions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "execution_id" UUID NOT NULL,
    "node_run_id" UUID NOT NULL,
    "action_type" TEXT NOT NULL,
    "configuration_json" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requested" BOOLEAN NOT NULL DEFAULT false,
    "sequence" INTEGER NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "idempotency_key" TEXT NOT NULL,
    "lease_owner" UUID,
    "lease_until" TIMESTAMPTZ(6),
    "error_code" TEXT,
    "executed_at" TIMESTAMPTZ(6),

    CONSTRAINT "workflow_compensation_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_action_invocations" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "execution_id" UUID NOT NULL,
    "node_run_id" UUID NOT NULL,
    "action_code" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "domain_result_ref" JSONB,
    "error_code" TEXT,

    CONSTRAINT "workflow_action_invocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_external_callbacks" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "execution_id" UUID NOT NULL,
    "node_run_id" UUID NOT NULL,
    "correlation_token_hash" TEXT NOT NULL,
    "nonce_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "received_at" TIMESTAMPTZ(6),
    "payload_hash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',

    CONSTRAINT "workflow_external_callbacks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_templates" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "definition_snapshot_json" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "owner_user_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_reconciliation_jobs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "requested_by_user_id" UUID NOT NULL,
    "execution_ids" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "correlation_id" UUID NOT NULL,
    "result" JSONB,
    "error_code" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_reconciliation_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_outbound_connections" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "base_url" TEXT NOT NULL,
    "allowed_hosts" JSONB NOT NULL,
    "secret_reference" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_user_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_outbound_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workflow_definitions_workspace_id_status_bound_entity_type_idx" ON "workflow_definitions"("workspace_id", "status", "bound_entity_type");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_definitions_workspace_id_id_key" ON "workflow_definitions"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_definitions_workspace_id_code_key" ON "workflow_definitions"("workspace_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_versions_workspace_id_id_key" ON "workflow_versions"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_versions_workspace_id_definition_id_id_key" ON "workflow_versions"("workspace_id", "definition_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_versions_workspace_id_definition_id_version_number_key" ON "workflow_versions"("workspace_id", "definition_id", "version_number");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_nodes_workspace_id_version_id_id_key" ON "workflow_nodes"("workspace_id", "version_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_nodes_workspace_id_version_id_node_key_key" ON "workflow_nodes"("workspace_id", "version_id", "node_key");

-- CreateIndex
CREATE INDEX "workflow_edges_workspace_id_version_id_from_node_id_idx" ON "workflow_edges"("workspace_id", "version_id", "from_node_id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_edges_workspace_id_version_id_id_key" ON "workflow_edges"("workspace_id", "version_id", "id");

-- CreateIndex
CREATE INDEX "workflow_triggers_enabled_next_scheduled_at_idx" ON "workflow_triggers"("enabled", "next_scheduled_at");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_triggers_workspace_id_id_key" ON "workflow_triggers"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_runtime_policies_workspace_id_key" ON "workflow_runtime_policies"("workspace_id");

-- CreateIndex
CREATE INDEX "workflow_executions_workspace_id_entity_type_entity_id_stat_idx" ON "workflow_executions"("workspace_id", "entity_type", "entity_id", "status");

-- CreateIndex
CREATE INDEX "workflow_executions_workspace_id_definition_id_status_idx" ON "workflow_executions"("workspace_id", "definition_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_executions_workspace_id_id_key" ON "workflow_executions"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_entity_locks_workspace_id_entity_type_entity_id_lo_key" ON "workflow_entity_locks"("workspace_id", "entity_type", "entity_id", "lock_scope");

-- CreateIndex
CREATE INDEX "workflow_execution_tokens_status_available_at_idx" ON "workflow_execution_tokens"("status", "available_at");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_execution_tokens_workspace_id_id_key" ON "workflow_execution_tokens"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_execution_tokens_workspace_id_execution_id_activat_key" ON "workflow_execution_tokens"("workspace_id", "execution_id", "activation_key");

-- CreateIndex
CREATE INDEX "workflow_node_executions_status_lease_until_idx" ON "workflow_node_executions"("status", "lease_until");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_node_executions_workspace_id_id_key" ON "workflow_node_executions"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_node_executions_workspace_id_execution_id_node_id__key" ON "workflow_node_executions"("workspace_id", "execution_id", "node_id", "iteration_number", "activation_key");

-- CreateIndex
CREATE INDEX "workflow_execution_logs_workspace_id_execution_id_occurred__idx" ON "workflow_execution_logs"("workspace_id", "execution_id", "occurred_at", "id");

-- CreateIndex
CREATE INDEX "workflow_human_assignments_status_due_at_idx" ON "workflow_human_assignments"("status", "due_at");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_human_assignments_workspace_id_id_key" ON "workflow_human_assignments"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_human_assignments_workspace_id_node_run_id_key" ON "workflow_human_assignments"("workspace_id", "node_run_id");

-- CreateIndex
CREATE INDEX "workflow_assignment_participants_workspace_id_effective_use_idx" ON "workflow_assignment_participants"("workspace_id", "effective_user_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_assignment_participants_workspace_id_id_key" ON "workflow_assignment_participants"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_assignment_participants_workspace_id_assignment_id_key" ON "workflow_assignment_participants"("workspace_id", "assignment_id", "original_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_approval_votes_workspace_id_assignment_id_particip_key" ON "workflow_approval_votes"("workspace_id", "assignment_id", "participant_id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_approval_votes_workspace_id_assignment_id_assignee_key" ON "workflow_approval_votes"("workspace_id", "assignment_id", "assignee_user_id");

-- CreateIndex
CREATE INDEX "workflow_assignment_history_workspace_id_assignment_id_occu_idx" ON "workflow_assignment_history"("workspace_id", "assignment_id", "occurred_at", "id");

-- CreateIndex
CREATE INDEX "workflow_timers_status_scheduled_for_idx" ON "workflow_timers"("status", "scheduled_for");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_timers_workspace_id_id_key" ON "workflow_timers"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_timers_workspace_id_unique_resume_key_key" ON "workflow_timers"("workspace_id", "unique_resume_key");

-- CreateIndex
CREATE INDEX "workflow_event_subscriptions_workspace_id_event_type_correl_idx" ON "workflow_event_subscriptions"("workspace_id", "event_type", "correlation_key", "status");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_event_subscriptions_workspace_id_id_key" ON "workflow_event_subscriptions"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_event_subscriptions_workspace_id_execution_id_node_key" ON "workflow_event_subscriptions"("workspace_id", "execution_id", "node_run_id", "event_type", "correlation_key");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_parallel_joins_workspace_id_id_key" ON "workflow_parallel_joins"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_parallel_joins_workspace_id_execution_id_split_act_key" ON "workflow_parallel_joins"("workspace_id", "execution_id", "split_activation_key", "join_node_key");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_child_executions_workspace_id_parent_node_run_id_key" ON "workflow_child_executions"("workspace_id", "parent_node_run_id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_child_executions_workspace_id_child_execution_id_key" ON "workflow_child_executions"("workspace_id", "child_execution_id");

-- CreateIndex
CREATE INDEX "workflow_compensation_actions_requested_status_lease_until_idx" ON "workflow_compensation_actions"("requested", "status", "lease_until");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_compensation_actions_workspace_id_id_key" ON "workflow_compensation_actions"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_compensation_actions_workspace_id_execution_id_nod_key" ON "workflow_compensation_actions"("workspace_id", "execution_id", "node_run_id", "action_type");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_compensation_actions_workspace_id_idempotency_key_key" ON "workflow_compensation_actions"("workspace_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_action_invocations_workspace_id_id_key" ON "workflow_action_invocations"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_action_invocations_workspace_id_node_run_id_action_key" ON "workflow_action_invocations"("workspace_id", "node_run_id", "action_code", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_external_callbacks_correlation_token_hash_key" ON "workflow_external_callbacks"("correlation_token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_external_callbacks_workspace_id_id_key" ON "workflow_external_callbacks"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "workflow_templates_workspace_id_category_status_idx" ON "workflow_templates"("workspace_id", "category", "status");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_templates_workspace_id_id_key" ON "workflow_templates"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "workflow_reconciliation_jobs_status_created_at_idx" ON "workflow_reconciliation_jobs"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_reconciliation_jobs_workspace_id_id_key" ON "workflow_reconciliation_jobs"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "integration_outbound_connections_workspace_id_id_key" ON "integration_outbound_connections"("workspace_id", "id");

-- Enforce tenant references even for direct SQL and worker writes.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['workflow_definitions','workflow_versions','workflow_nodes','workflow_edges','workflow_triggers','workflow_runtime_policies',
    'workflow_executions','workflow_execution_tokens','workflow_node_executions','workflow_execution_logs','workflow_human_assignments',
    'workflow_assignment_participants','workflow_approval_votes','workflow_assignment_history','workflow_timers','workflow_event_subscriptions',
    'workflow_parallel_joins','workflow_child_executions','workflow_compensation_actions','workflow_action_invocations','workflow_external_callbacks',
    'workflow_templates','workflow_reconciliation_jobs','workflow_entity_locks','integration_outbound_connections'] LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT',t,t||'_workspace_fk');
  END LOOP;
END $$;
ALTER TABLE workflow_definitions
  ADD CONSTRAINT workflow_creator_fk FOREIGN KEY (workspace_id,created_by_user_id) REFERENCES workspace_memberships(workspace_id,user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT workflow_service_actor_fk FOREIGN KEY (workspace_id,service_account_user_id) REFERENCES workspace_memberships(workspace_id,user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT workflow_definition_ck CHECK (type IN ('SEQUENTIAL','STATUS_DRIVEN') AND status IN ('DRAFT','ACTIVE','PAUSED','ARCHIVED') AND version > 0
    AND concurrency_mode IN ('ONE_PER_DEFINITION_PER_ENTITY','ALLOW_PARALLEL','ONE_WORKFLOW_PER_ENTITY','CUSTOM_KEY')
    AND code ~ '^[A-Z][A-Z0-9_]{1,63}$' AND run_as IN ('STARTER','SERVICE_ACCOUNT') AND (run_as='SERVICE_ACCOUNT')=(service_account_user_id IS NOT NULL));
ALTER TABLE workflow_versions
  ADD CONSTRAINT workflow_version_definition_fk FOREIGN KEY (workspace_id,definition_id) REFERENCES workflow_definitions(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT workflow_publisher_fk FOREIGN KEY (workspace_id,published_by) REFERENCES workspace_memberships(workspace_id,user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT workflow_version_ck CHECK (version_number > 0 AND revision > 0 AND status IN ('DRAFT','PUBLISHED','SUPERSEDED','ARCHIVED')
    AND (status='DRAFT' OR (checksum ~ '^[0-9a-f]{64}$' AND published_at IS NOT NULL AND published_by IS NOT NULL)));
ALTER TABLE workflow_definitions ADD CONSTRAINT workflow_current_publication_fk FOREIGN KEY (workspace_id,id,current_version_id) REFERENCES workflow_versions(workspace_id,definition_id,id) ON DELETE RESTRICT;
ALTER TABLE workflow_nodes ADD CONSTRAINT workflow_node_version_fk FOREIGN KEY (workspace_id,version_id) REFERENCES workflow_versions(workspace_id,id) ON DELETE RESTRICT;
ALTER TABLE workflow_edges
  ADD CONSTRAINT workflow_edge_version_fk FOREIGN KEY (workspace_id,version_id) REFERENCES workflow_versions(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT workflow_edge_source_fk FOREIGN KEY (workspace_id,version_id,from_node_id) REFERENCES workflow_nodes(workspace_id,version_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT workflow_edge_target_fk FOREIGN KEY (workspace_id,version_id,to_node_id) REFERENCES workflow_nodes(workspace_id,version_id,id) ON DELETE RESTRICT;
ALTER TABLE workflow_triggers ADD CONSTRAINT workflow_trigger_definition_fk FOREIGN KEY (workspace_id,definition_id) REFERENCES workflow_definitions(workspace_id,id) ON DELETE RESTRICT;
ALTER TABLE workflow_executions
  ADD CONSTRAINT workflow_execution_version_fk FOREIGN KEY (workspace_id,definition_id,version_id) REFERENCES workflow_versions(workspace_id,definition_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT workflow_execution_actor_fk FOREIGN KEY (workspace_id,execution_user_id) REFERENCES workspace_memberships(workspace_id,user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT workflow_execution_starter_fk FOREIGN KEY (workspace_id,started_by_id) REFERENCES workspace_memberships(workspace_id,user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT workflow_execution_parent_fk FOREIGN KEY (workspace_id,parent_execution_id) REFERENCES workflow_executions(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT workflow_execution_ck CHECK (status IN ('QUEUED','RUNNING','WAITING','SUSPENDED','COMPLETED','FAILED','CANCELLED','TERMINATED','TIMED_OUT')
    AND run_as IN ('STARTER','SERVICE_ACCOUNT') AND version > 0 AND depth >= 0 AND depth <= 10 AND expires_at > started_at
    AND concurrency_mode IN ('ONE_PER_DEFINITION_PER_ENTITY','ALLOW_PARALLEL','ONE_WORKFLOW_PER_ENTITY','CUSTOM_KEY'));
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['workflow_execution_tokens','workflow_node_executions','workflow_execution_logs','workflow_human_assignments','workflow_timers',
    'workflow_event_subscriptions','workflow_parallel_joins','workflow_compensation_actions','workflow_action_invocations','workflow_external_callbacks','workflow_entity_locks'] LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (workspace_id,execution_id) REFERENCES workflow_executions(workspace_id,id) ON DELETE RESTRICT',t,t||'_execution_fk');
  END LOOP;
  FOREACH t IN ARRAY ARRAY['workflow_execution_logs','workflow_human_assignments','workflow_timers','workflow_event_subscriptions','workflow_compensation_actions','workflow_action_invocations','workflow_external_callbacks'] LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (workspace_id,node_run_id) REFERENCES workflow_node_executions(workspace_id,id) ON DELETE RESTRICT',t,t||'_node_run_fk');
  END LOOP;
  FOREACH t IN ARRAY ARRAY['workflow_assignment_participants','workflow_approval_votes','workflow_assignment_history'] LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (workspace_id,assignment_id) REFERENCES workflow_human_assignments(workspace_id,id) ON DELETE RESTRICT',t,t||'_assignment_fk');
  END LOOP;
END $$;
ALTER TABLE workflow_node_executions ADD CONSTRAINT workflow_node_run_token_fk FOREIGN KEY (workspace_id,token_id) REFERENCES workflow_execution_tokens(workspace_id,id) ON DELETE RESTRICT;
ALTER TABLE workflow_execution_tokens
  ADD CONSTRAINT workflow_token_join_fk FOREIGN KEY (workspace_id,join_group_id) REFERENCES workflow_parallel_joins(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT workflow_token_ck CHECK (status IN ('READY','RUNNING','WAITING','COMPLETED','CANCELLED','FAILED') AND iteration_number >= 0 AND version > 0);
ALTER TABLE workflow_node_executions ADD CONSTRAINT workflow_node_run_ck CHECK (status IN ('QUEUED','RUNNING','WAITING','SUCCEEDED','FAILED','CANCELLED') AND attempt_count >= 0 AND iteration_number >= 0);
ALTER TABLE workflow_human_assignments ADD CONSTRAINT workflow_assignment_ck CHECK (status IN ('PENDING','COMPLETED','CANCELLED','EXPIRED')
  AND assignment_type IN ('APPROVAL','REQUEST_INFO') AND policy IN ('ANY','ALL','QUORUM') AND (policy <> 'QUORUM' OR quorum_count > 0) AND version > 0);
ALTER TABLE workflow_assignment_participants
  ADD CONSTRAINT workflow_participant_original_fk FOREIGN KEY (workspace_id,original_user_id) REFERENCES workspace_memberships(workspace_id,user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT workflow_participant_effective_fk FOREIGN KEY (workspace_id,effective_user_id) REFERENCES workspace_memberships(workspace_id,user_id) ON DELETE RESTRICT;
ALTER TABLE workflow_approval_votes
  ADD CONSTRAINT workflow_vote_participant_fk FOREIGN KEY (workspace_id,participant_id) REFERENCES workflow_assignment_participants(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT workflow_vote_actor_fk FOREIGN KEY (workspace_id,acted_by_user_id) REFERENCES workspace_memberships(workspace_id,user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT workflow_vote_assignee_fk FOREIGN KEY (workspace_id,assignee_user_id) REFERENCES workspace_memberships(workspace_id,user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT workflow_vote_decision_ck CHECK (decision IN ('APPROVE','REJECT','REQUEST_CHANGES','SUBMIT_INFORMATION'));
ALTER TABLE workflow_assignment_history ADD CONSTRAINT workflow_assignment_history_actor_fk FOREIGN KEY (workspace_id,actor_user_id) REFERENCES workspace_memberships(workspace_id,user_id) ON DELETE RESTRICT;
ALTER TABLE workflow_child_executions
  ADD CONSTRAINT workflow_child_parent_fk FOREIGN KEY (workspace_id,parent_execution_id) REFERENCES workflow_executions(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT workflow_child_instance_fk FOREIGN KEY (workspace_id,child_execution_id) REFERENCES workflow_executions(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT workflow_child_node_fk FOREIGN KEY (workspace_id,parent_node_run_id) REFERENCES workflow_node_executions(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT workflow_child_not_self_ck CHECK (parent_execution_id <> child_execution_id);
ALTER TABLE workflow_templates ADD CONSTRAINT workflow_template_owner_fk FOREIGN KEY (workspace_id,owner_user_id) REFERENCES workspace_memberships(workspace_id,user_id) ON DELETE RESTRICT;
ALTER TABLE workflow_reconciliation_jobs ADD CONSTRAINT workflow_reconcile_actor_fk FOREIGN KEY (workspace_id,requested_by_user_id) REFERENCES workspace_memberships(workspace_id,user_id) ON DELETE RESTRICT;
ALTER TABLE integration_outbound_connections ADD CONSTRAINT integration_connection_creator_fk FOREIGN KEY (workspace_id,created_by_user_id) REFERENCES workspace_memberships(workspace_id,user_id) ON DELETE RESTRICT;
ALTER TABLE workflow_runtime_policies ADD CONSTRAINT workflow_limits_ck CHECK (max_loop_iterations BETWEEN 1 AND 1000 AND max_node_runs BETWEEN 1 AND 10000
  AND max_depth BETWEEN 1 AND 10 AND max_lifetime_days BETWEEN 1 AND 365 AND retention_days BETWEEN 1 AND 3650 AND max_concurrent_executions BETWEEN 1 AND 10000 AND version > 0);
ALTER TABLE workflow_timers ADD CONSTRAINT workflow_timer_ck CHECK (type IN ('ABSOLUTE','RELATIVE','WORKDAY_AWARE') AND status IN ('PENDING','FIRED','CANCELLED','PAUSED') AND (remaining_seconds IS NULL OR remaining_seconds >= 0));
ALTER TABLE workflow_event_subscriptions ADD CONSTRAINT workflow_subscription_ck CHECK (status IN ('PENDING','FULFILLED','CANCELLED'));
ALTER TABLE workflow_parallel_joins ADD CONSTRAINT workflow_join_ck CHECK (join_mode IN ('ALL','ANY','QUORUM') AND required_count > 0 AND status IN ('PENDING','COMPLETED','CANCELLED') AND jsonb_typeof(branches)='array' AND jsonb_typeof(completed_branch_tokens)='array');

CREATE FUNCTION workflow_guard_published_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'DRAFT' THEN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'WORKFLOW_PUBLISHED_IMMUTABLE'; END IF;
    IF (to_jsonb(OLD)-'status') IS DISTINCT FROM (to_jsonb(NEW)-'status')
      OR NOT ((OLD.status='PUBLISHED' AND NEW.status IN ('PUBLISHED','SUPERSEDED','ARCHIVED')) OR (OLD.status='SUPERSEDED' AND NEW.status IN ('SUPERSEDED','ARCHIVED')) OR (OLD.status='ARCHIVED' AND NEW.status='ARCHIVED')) THEN
      RAISE EXCEPTION 'WORKFLOW_PUBLISHED_IMMUTABLE';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workflow_version_immutable BEFORE UPDATE OR DELETE ON workflow_versions FOR EACH ROW EXECUTE FUNCTION workflow_guard_published_version();
CREATE FUNCTION workflow_guard_graph_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE version_status text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    SELECT status INTO version_status FROM workflow_versions WHERE workspace_id=OLD.workspace_id AND id=OLD.version_id FOR SHARE;
    IF version_status <> 'DRAFT' THEN RAISE EXCEPTION 'WORKFLOW_PUBLISHED_IMMUTABLE'; END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT status INTO version_status FROM workflow_versions WHERE workspace_id=NEW.workspace_id AND id=NEW.version_id FOR SHARE;
    IF version_status IS DISTINCT FROM 'DRAFT' THEN RAISE EXCEPTION 'WORKFLOW_PUBLISHED_IMMUTABLE'; END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER workflow_node_immutable BEFORE INSERT OR UPDATE OR DELETE ON workflow_nodes FOR EACH ROW EXECUTE FUNCTION workflow_guard_graph_write();
CREATE TRIGGER workflow_edge_immutable BEFORE INSERT OR UPDATE OR DELETE ON workflow_edges FOR EACH ROW EXECUTE FUNCTION workflow_guard_graph_write();
CREATE FUNCTION workflow_node_run_owner_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workflow_executions e JOIN workflow_nodes n ON n.workspace_id=e.workspace_id AND n.version_id=e.version_id
    JOIN workflow_execution_tokens t ON t.workspace_id=e.workspace_id AND t.execution_id=e.id
    WHERE e.workspace_id=NEW.workspace_id AND e.id=NEW.execution_id AND n.id=NEW.node_id AND t.id=NEW.token_id AND t.node_key=n.node_key) THEN
    RAISE EXCEPTION 'WORKFLOW_NODE_INVALID' USING ERRCODE='23503';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workflow_node_run_owner BEFORE INSERT OR UPDATE ON workflow_node_executions FOR EACH ROW EXECUTE FUNCTION workflow_node_run_owner_guard();
CREATE FUNCTION workflow_node_run_reference_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.node_run_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM workflow_node_executions n WHERE n.workspace_id=NEW.workspace_id AND n.execution_id=NEW.execution_id AND n.id=NEW.node_run_id) THEN
    RAISE EXCEPTION 'WORKFLOW_NODE_INVALID' USING ERRCODE='23503';
  END IF;
  RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['workflow_execution_logs','workflow_human_assignments','workflow_timers','workflow_event_subscriptions','workflow_compensation_actions','workflow_action_invocations','workflow_external_callbacks'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION workflow_node_run_reference_guard()',t||'_node_owner',t);
  END LOOP;
END $$;
CREATE FUNCTION workflow_reject_evidence_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'WORKFLOW_HISTORY_IMMUTABLE'; END $$;
CREATE TRIGGER workflow_vote_immutable BEFORE UPDATE OR DELETE ON workflow_approval_votes FOR EACH ROW EXECUTE FUNCTION workflow_reject_evidence_change();
CREATE TRIGGER workflow_assignment_history_immutable BEFORE UPDATE OR DELETE ON workflow_assignment_history FOR EACH ROW EXECUTE FUNCTION workflow_reject_evidence_change();
CREATE FUNCTION workflow_vote_owner_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workflow_assignment_participants p WHERE p.workspace_id=NEW.workspace_id AND p.assignment_id=NEW.assignment_id
    AND p.id=NEW.participant_id AND p.is_active AND p.effective_user_id=NEW.assignee_user_id) THEN
    RAISE EXCEPTION 'WORKFLOW_APPROVAL_POLICY_INVALID' USING ERRCODE='23503';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workflow_vote_owner BEFORE INSERT ON workflow_approval_votes FOR EACH ROW EXECUTE FUNCTION workflow_vote_owner_guard();
CREATE UNIQUE INDEX workflow_active_concurrency_key ON workflow_executions(workspace_id,concurrency_key)
  WHERE concurrency_key IS NOT NULL AND status IN ('QUEUED','RUNNING','WAITING','SUSPENDED');
CREATE FUNCTION workflow_execution_snapshot_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(OLD.workspace_id,OLD.definition_id,OLD.version_id,OLD.snapshot,OLD.entity_type,OLD.entity_id,OLD.run_as,OLD.execution_user_id,
      OLD.started_by_type,OLD.started_by_id,OLD.parameters,OLD.concurrency_mode,OLD.concurrency_key,OLD.depth,OLD.ancestry,OLD.parent_execution_id)
    IS DISTINCT FROM ROW(NEW.workspace_id,NEW.definition_id,NEW.version_id,NEW.snapshot,NEW.entity_type,NEW.entity_id,NEW.run_as,NEW.execution_user_id,
      NEW.started_by_type,NEW.started_by_id,NEW.parameters,NEW.concurrency_mode,NEW.concurrency_key,NEW.depth,NEW.ancestry,NEW.parent_execution_id) THEN
    RAISE EXCEPTION 'WORKFLOW_EXECUTION_SNAPSHOT_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workflow_execution_pinned BEFORE UPDATE ON workflow_executions FOR EACH ROW EXECUTE FUNCTION workflow_execution_snapshot_guard();
ALTER TABLE workflow_execution_logs ADD CONSTRAINT workflow_log_classification_ck CHECK (classification IN ('PUBLIC','BUSINESS','SENSITIVE'));
