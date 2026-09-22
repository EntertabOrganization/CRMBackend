-- CRM Core/Pipelines foundation.

CREATE TYPE "CrmPipelineEntityType" AS ENUM ('LEAD', 'DEAL');
CREATE TYPE "CrmStageSemanticType" AS ENUM ('PROGRESS', 'SUCCESS', 'FAILURE');
CREATE TYPE "CrmLeadStatus" AS ENUM ('ACTIVE', 'QUALIFIED', 'DISQUALIFIED');
CREATE TYPE "CrmDealStatus" AS ENUM ('OPEN', 'WON', 'LOST');

CREATE TABLE "crm_pipelines" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "entity_type" "CrmPipelineEntityType" NOT NULL,
    "name" TEXT NOT NULL,
    "normalized_name" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "transition_rules_enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "crm_pipelines_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "crm_stages" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "pipeline_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "semantic_type" "CrmStageSemanticType" NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "crm_stages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "crm_stage_transitions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "pipeline_id" UUID NOT NULL,
    "from_stage_id" UUID NOT NULL,
    "to_stage_id" UUID NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "crm_stage_transitions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "crm_lost_reasons" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "crm_lost_reasons_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "crm_leads" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "responsible_user_id" UUID NOT NULL,
    "pipeline_id" UUID NOT NULL,
    "stage_id" UUID NOT NULL,
    "status" "CrmLeadStatus" NOT NULL,
    "lost_reason_id" UUID,
    "lost_reason_comment" TEXT,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "crm_leads_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "crm_deals" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "responsible_user_id" UUID NOT NULL,
    "pipeline_id" UUID NOT NULL,
    "stage_id" UUID NOT NULL,
    "status" "CrmDealStatus" NOT NULL,
    "amount" DOUBLE PRECISION,
    "currency_code" TEXT,
    "lost_reason_id" UUID,
    "lost_reason_comment" TEXT,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "crm_deals_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "crm_stage_history" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "entity_type" "CrmPipelineEntityType" NOT NULL,
    "record_id" UUID NOT NULL,
    "from_pipeline_id" UUID,
    "from_stage_id" UUID,
    "to_pipeline_id" UUID NOT NULL,
    "to_stage_id" UUID NOT NULL,
    "moved_by_user_id" UUID NOT NULL,
    "moved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "correlation_id" TEXT,
    CONSTRAINT "crm_stage_history_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "actor_user_id" UUID,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB NOT NULL,
    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "crm_pipelines_workspace_id_entity_type_is_active_idx" ON "crm_pipelines"("workspace_id", "entity_type", "is_active");
CREATE INDEX "crm_pipelines_workspace_id_entity_type_is_default_idx" ON "crm_pipelines"("workspace_id", "entity_type", "is_default");
CREATE UNIQUE INDEX "crm_pipelines_workspace_id_entity_type_normalized_name_is_active_key" ON "crm_pipelines"("workspace_id", "entity_type", "normalized_name", "is_active");

CREATE INDEX "crm_stages_workspace_id_pipeline_id_is_active_idx" ON "crm_stages"("workspace_id", "pipeline_id", "is_active");
CREATE INDEX "crm_stages_pipeline_id_is_default_idx" ON "crm_stages"("pipeline_id", "is_default");
CREATE UNIQUE INDEX "crm_stages_pipeline_id_name_is_active_key" ON "crm_stages"("pipeline_id", "name", "is_active");

CREATE UNIQUE INDEX "crm_stage_transitions_pipeline_id_from_stage_id_to_stage_id_is_active_key" ON "crm_stage_transitions"("pipeline_id", "from_stage_id", "to_stage_id", "is_active");
CREATE INDEX "crm_stage_transitions_workspace_id_pipeline_id_idx" ON "crm_stage_transitions"("workspace_id", "pipeline_id");

CREATE UNIQUE INDEX "crm_lost_reasons_workspace_id_name_is_active_key" ON "crm_lost_reasons"("workspace_id", "name", "is_active");

CREATE INDEX "crm_leads_workspace_id_responsible_user_id_idx" ON "crm_leads"("workspace_id", "responsible_user_id");
CREATE INDEX "crm_leads_workspace_id_pipeline_id_stage_id_idx" ON "crm_leads"("workspace_id", "pipeline_id", "stage_id");

CREATE INDEX "crm_deals_workspace_id_responsible_user_id_idx" ON "crm_deals"("workspace_id", "responsible_user_id");
CREATE INDEX "crm_deals_workspace_id_pipeline_id_stage_id_idx" ON "crm_deals"("workspace_id", "pipeline_id", "stage_id");

CREATE INDEX "crm_stage_history_workspace_id_entity_type_record_id_moved_at_idx" ON "crm_stage_history"("workspace_id", "entity_type", "record_id", "moved_at");
CREATE INDEX "outbox_events_workspace_id_event_type_occurred_at_idx" ON "outbox_events"("workspace_id", "event_type", "occurred_at");
