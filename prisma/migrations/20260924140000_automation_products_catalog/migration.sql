-- CreateEnum
CREATE TYPE "AutomationRuleState" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'DISABLED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "AutomationRevisionState" AS ENUM ('DRAFT', 'PUBLISHED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "AutomationJobStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AutomationExecutionStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'SUCCEEDED_WITH_ERRORS', 'FAILED_RETRYABLE', 'FAILED_FINAL', 'SKIPPED_CONDITION', 'SKIPPED_STALE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AutomationActionStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "CatalogProductType" AS ENUM ('SIMPLE_PRODUCT', 'PRODUCT_WITH_VARIANTS', 'VARIANT', 'SERVICE');

-- CreateEnum
CREATE TYPE "CatalogProductState" AS ENUM ('ACTIVE', 'INACTIVE', 'ARCHIVED');

-- AlterTable
ALTER TABLE "outbox_events" ADD COLUMN     "automation_depth" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "automation_processed_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "automation_rules" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "target_type" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "state" "AutomationRuleState" NOT NULL DEFAULT 'DRAFT',
    "active_revision_id" UUID,
    "draft_revision_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_user_id" UUID NOT NULL,
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_rule_revisions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "revision_number" INTEGER NOT NULL,
    "state" "AutomationRevisionState" NOT NULL DEFAULT 'DRAFT',
    "trigger_code" TEXT,
    "trigger_config" JSONB NOT NULL DEFAULT '{}',
    "condition_tree" JSONB,
    "conditions_version" INTEGER NOT NULL DEFAULT 1,
    "timing" JSONB NOT NULL DEFAULT '{"mode":"IMMEDIATE"}',
    "execution_policy" JSONB NOT NULL DEFAULT '{}',
    "config_hash" TEXT,
    "published_at" TIMESTAMP(3),
    "published_by_user_id" UUID,
    "superseded_at" TIMESTAMP(3),
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_rule_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_actions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "action_code" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "name" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "continue_on_error" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_jobs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "rule_revision_id" UUID NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" UUID NOT NULL,
    "source_event_id" TEXT NOT NULL,
    "trigger_code" TEXT NOT NULL,
    "timing_mode" TEXT NOT NULL,
    "scheduled_at" TIMESTAMP(3) NOT NULL,
    "status" "AutomationJobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "idempotency_key" TEXT NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "causation_id" TEXT,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "trigger_context" JSONB NOT NULL,
    "initiator_type" TEXT,
    "initiator_id" UUID,
    "identity_kind" TEXT NOT NULL,
    "execution_id" UUID,
    "lease_expires_at" TIMESTAMP(3),
    "claimed_by" TEXT,
    "last_error_code" TEXT,
    "cancelled_at" TIMESTAMP(3),
    "cancelled_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_executions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "rule_revision_id" UUID NOT NULL,
    "rule_name" TEXT NOT NULL,
    "revision_number" INTEGER NOT NULL,
    "job_id" UUID,
    "target_type" TEXT NOT NULL,
    "target_id" UUID NOT NULL,
    "target_title" TEXT,
    "source_event_id" TEXT NOT NULL,
    "trigger_code" TEXT NOT NULL,
    "timing_mode" TEXT NOT NULL,
    "status" "AutomationExecutionStatus" NOT NULL DEFAULT 'PENDING',
    "initiator_type" TEXT,
    "initiator_id" UUID,
    "identity_kind" TEXT NOT NULL,
    "identity_user_id" UUID,
    "correlation_id" TEXT NOT NULL,
    "causation_id" TEXT,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "condition_outcome" JSONB,
    "skip_reason" TEXT,
    "error_code" TEXT,
    "error_summary" TEXT,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "is_manual" BOOLEAN NOT NULL DEFAULT false,
    "started_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_action_executions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "execution_id" UUID NOT NULL,
    "action_id" UUID NOT NULL,
    "action_code" TEXT NOT NULL,
    "action_order" INTEGER NOT NULL,
    "status" "AutomationActionStatus" NOT NULL DEFAULT 'PENDING',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "idempotency_key" TEXT NOT NULL,
    "continue_on_error" BOOLEAN NOT NULL DEFAULT false,
    "retryable" BOOLEAN NOT NULL DEFAULT false,
    "error_code" TEXT,
    "error_message" TEXT,
    "result" JSONB,
    "attempts" JSONB NOT NULL DEFAULT '[]',
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_action_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_logs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "rule_id" UUID,
    "execution_id" UUID,
    "job_id" UUID,
    "level" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB,
    "correlation_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_extension_definitions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "installation_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "target_types" JSONB NOT NULL DEFAULT '[]',
    "config_schema" JSONB,
    "payload_schema" JSONB,
    "handler" JSONB,
    "permissions" JSONB NOT NULL DEFAULT '[]',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_by_user_id" UUID NOT NULL,
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_extension_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_integration_credentials" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "installation_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "secret_hash" TEXT NOT NULL,
    "trigger_codes" JSONB NOT NULL DEFAULT '[]',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_used_at" TIMESTAMP(3),
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "automation_integration_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_settings" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "default_catalog_id" UUID,
    "base_price_type_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "catalog_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalogs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "normalized_name" TEXT NOT NULL,
    "code" TEXT,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_user_id" UUID,
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "catalogs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_categories" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "catalog_id" UUID NOT NULL,
    "parent_id" UUID,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "description" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "catalog_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_product_categories" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_product_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_products" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "catalog_id" UUID NOT NULL,
    "type" "CatalogProductType" NOT NULL,
    "parent_id" UUID,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "sku_key" TEXT,
    "description" TEXT,
    "short_description" TEXT,
    "state" "CatalogProductState" NOT NULL DEFAULT 'ACTIVE',
    "archive_cause" TEXT,
    "archived_at" TIMESTAMP(3),
    "archived_by_user_id" UUID,
    "primary_category_id" UUID,
    "primary_unit_id" UUID,
    "taxable" BOOLEAN NOT NULL DEFAULT false,
    "tax_rate" DECIMAL(9,4),
    "tax_included" BOOLEAN NOT NULL DEFAULT false,
    "tax_code" TEXT,
    "weight" DECIMAL(28,8),
    "length" DECIMAL(28,8),
    "width" DECIMAL(28,8),
    "height" DECIMAL(28,8),
    "barcode" TEXT,
    "variant_axes" JSONB NOT NULL DEFAULT '[]',
    "axis_key" TEXT,
    "axis_values" JSONB,
    "overrides" JSONB NOT NULL DEFAULT '[]',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_user_id" UUID,
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "catalog_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_units" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "symbol" TEXT,
    "precision" INTEGER NOT NULL DEFAULT 6,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "catalog_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_product_unit_ratios" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "base_unit_id" UUID NOT NULL,
    "ratio" DECIMAL(28,8) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "catalog_product_unit_ratios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_price_types" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "catalog_price_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_product_prices" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "price_type_id" UUID NOT NULL,
    "amount" DECIMAL(28,8) NOT NULL,
    "currency" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "catalog_product_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_property_profiles" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "field_id" UUID NOT NULL,
    "applies_to" TEXT NOT NULL DEFAULT 'BOTH',
    "variant_axis" BOOLEAN NOT NULL DEFAULT false,
    "filterable" BOOLEAN NOT NULL DEFAULT false,
    "searchable" BOOLEAN NOT NULL DEFAULT false,
    "display_on_card" BOOLEAN NOT NULL DEFAULT false,
    "display_in_list" BOOLEAN NOT NULL DEFAULT false,
    "storefront_visible" BOOLEAN NOT NULL DEFAULT false,
    "category_ids" JSONB NOT NULL DEFAULT '[]',
    "allowed_types" JSONB NOT NULL DEFAULT '[]',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "catalog_property_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_product_media" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "alt_text" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_product_media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commercial_product_rows" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "owner_type" TEXT NOT NULL,
    "owner_id" UUID NOT NULL,
    "product_id" UUID,
    "parent_product_id" UUID,
    "is_manual" BOOLEAN NOT NULL DEFAULT false,
    "name_snapshot" TEXT NOT NULL,
    "sku_snapshot" TEXT,
    "variant_snapshot" TEXT,
    "unit_id" UUID,
    "unit_code_snapshot" TEXT,
    "unit_name_snapshot" TEXT,
    "unit_ratio_snapshot" DECIMAL(28,8),
    "base_unit_code_snapshot" TEXT,
    "quantity" DECIMAL(28,8) NOT NULL,
    "price_type_id" UUID,
    "price_type_code_snapshot" TEXT,
    "unit_price" DECIMAL(28,8) NOT NULL,
    "currency" TEXT NOT NULL,
    "discount_type" TEXT NOT NULL DEFAULT 'NONE',
    "discount_value" DECIMAL(28,8) NOT NULL DEFAULT 0,
    "discount_amount" DECIMAL(28,8) NOT NULL DEFAULT 0,
    "taxable" BOOLEAN NOT NULL DEFAULT false,
    "tax_rate" DECIMAL(9,4) NOT NULL DEFAULT 0,
    "tax_included" BOOLEAN NOT NULL DEFAULT false,
    "tax_code_snapshot" TEXT,
    "subtotal" DECIMAL(28,8) NOT NULL,
    "tax_amount" DECIMAL(28,8) NOT NULL,
    "total" DECIMAL(28,8) NOT NULL,
    "price_overridden" BOOLEAN NOT NULL DEFAULT false,
    "discount_overridden" BOOLEAN NOT NULL DEFAULT false,
    "tax_overridden" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "commercial_product_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commercial_row_sets" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "owner_type" TEXT NOT NULL,
    "owner_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "currency" TEXT,
    "subtotal" DECIMAL(28,8) NOT NULL DEFAULT 0,
    "tax_total" DECIMAL(28,8) NOT NULL DEFAULT 0,
    "total" DECIMAL(28,8) NOT NULL DEFAULT 0,
    "updated_by_user_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "commercial_row_sets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "automation_rules_workspace_id_state_target_type_idx" ON "automation_rules"("workspace_id", "state", "target_type");

-- CreateIndex
CREATE INDEX "automation_rules_workspace_id_priority_idx" ON "automation_rules"("workspace_id", "priority");

-- CreateIndex
CREATE INDEX "automation_rule_revisions_workspace_id_rule_id_state_idx" ON "automation_rule_revisions"("workspace_id", "rule_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "automation_rule_revisions_rule_id_revision_number_key" ON "automation_rule_revisions"("rule_id", "revision_number");

-- CreateIndex
CREATE INDEX "automation_actions_workspace_id_revision_id_idx" ON "automation_actions"("workspace_id", "revision_id");

-- CreateIndex
CREATE UNIQUE INDEX "automation_actions_revision_id_sort_order_key" ON "automation_actions"("revision_id", "sort_order");

-- CreateIndex
CREATE INDEX "automation_jobs_status_scheduled_at_idx" ON "automation_jobs"("status", "scheduled_at");

-- CreateIndex
CREATE INDEX "automation_jobs_workspace_id_status_idx" ON "automation_jobs"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "automation_jobs_workspace_id_rule_id_idx" ON "automation_jobs"("workspace_id", "rule_id");

-- CreateIndex
CREATE INDEX "automation_jobs_workspace_id_target_type_target_id_idx" ON "automation_jobs"("workspace_id", "target_type", "target_id");

-- CreateIndex
CREATE UNIQUE INDEX "automation_jobs_workspace_id_idempotency_key_key" ON "automation_jobs"("workspace_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "automation_executions_workspace_id_rule_id_started_at_idx" ON "automation_executions"("workspace_id", "rule_id", "started_at");

-- CreateIndex
CREATE INDEX "automation_executions_workspace_id_target_type_target_id_st_idx" ON "automation_executions"("workspace_id", "target_type", "target_id", "started_at");

-- CreateIndex
CREATE INDEX "automation_executions_workspace_id_status_started_at_idx" ON "automation_executions"("workspace_id", "status", "started_at");

-- CreateIndex
CREATE INDEX "automation_executions_workspace_id_correlation_id_idx" ON "automation_executions"("workspace_id", "correlation_id");

-- CreateIndex
CREATE UNIQUE INDEX "automation_executions_workspace_id_rule_revision_id_source__key" ON "automation_executions"("workspace_id", "rule_revision_id", "source_event_id", "target_id");

-- CreateIndex
CREATE INDEX "automation_action_executions_workspace_id_execution_id_idx" ON "automation_action_executions"("workspace_id", "execution_id");

-- CreateIndex
CREATE UNIQUE INDEX "automation_action_executions_execution_id_action_order_key" ON "automation_action_executions"("execution_id", "action_order");

-- CreateIndex
CREATE INDEX "automation_logs_workspace_id_execution_id_created_at_idx" ON "automation_logs"("workspace_id", "execution_id", "created_at");

-- CreateIndex
CREATE INDEX "automation_logs_workspace_id_rule_id_created_at_idx" ON "automation_logs"("workspace_id", "rule_id", "created_at");

-- CreateIndex
CREATE INDEX "automation_extension_definitions_workspace_id_kind_enabled_idx" ON "automation_extension_definitions"("workspace_id", "kind", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "automation_extension_definitions_workspace_id_kind_code_key" ON "automation_extension_definitions"("workspace_id", "kind", "code");

-- CreateIndex
CREATE INDEX "automation_integration_credentials_workspace_id_installatio_idx" ON "automation_integration_credentials"("workspace_id", "installation_id");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_settings_workspace_id_key" ON "catalog_settings"("workspace_id");

-- CreateIndex
CREATE INDEX "catalogs_workspace_id_is_active_sort_order_idx" ON "catalogs"("workspace_id", "is_active", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "catalogs_workspace_id_normalized_name_key" ON "catalogs"("workspace_id", "normalized_name");

-- CreateIndex
CREATE UNIQUE INDEX "catalogs_workspace_id_code_key" ON "catalogs"("workspace_id", "code");

-- CreateIndex
CREATE INDEX "catalog_categories_workspace_id_catalog_id_parent_id_sort_o_idx" ON "catalog_categories"("workspace_id", "catalog_id", "parent_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_categories_catalog_id_code_key" ON "catalog_categories"("catalog_id", "code");

-- CreateIndex
CREATE INDEX "catalog_product_categories_workspace_id_category_id_idx" ON "catalog_product_categories"("workspace_id", "category_id");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_product_categories_product_id_category_id_key" ON "catalog_product_categories"("product_id", "category_id");

-- CreateIndex
CREATE INDEX "catalog_products_workspace_id_catalog_id_type_state_idx" ON "catalog_products"("workspace_id", "catalog_id", "type", "state");

-- CreateIndex
CREATE INDEX "catalog_products_workspace_id_parent_id_idx" ON "catalog_products"("workspace_id", "parent_id");

-- CreateIndex
CREATE INDEX "catalog_products_workspace_id_state_name_idx" ON "catalog_products"("workspace_id", "state", "name");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_products_workspace_id_sku_key_key" ON "catalog_products"("workspace_id", "sku_key");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_products_parent_id_axis_key_key" ON "catalog_products"("parent_id", "axis_key");

-- CreateIndex
CREATE INDEX "catalog_units_workspace_id_is_active_sort_order_idx" ON "catalog_units"("workspace_id", "is_active", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_units_workspace_id_code_key" ON "catalog_units"("workspace_id", "code");

-- CreateIndex
CREATE INDEX "catalog_product_unit_ratios_workspace_id_product_id_idx" ON "catalog_product_unit_ratios"("workspace_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_product_unit_ratios_product_id_unit_id_key" ON "catalog_product_unit_ratios"("product_id", "unit_id");

-- CreateIndex
CREATE INDEX "catalog_price_types_workspace_id_is_active_sort_order_idx" ON "catalog_price_types"("workspace_id", "is_active", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_price_types_workspace_id_code_key" ON "catalog_price_types"("workspace_id", "code");

-- CreateIndex
CREATE INDEX "catalog_product_prices_workspace_id_product_id_idx" ON "catalog_product_prices"("workspace_id", "product_id");

-- CreateIndex
CREATE INDEX "catalog_product_prices_workspace_id_price_type_id_idx" ON "catalog_product_prices"("workspace_id", "price_type_id");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_product_prices_product_id_price_type_id_currency_key" ON "catalog_product_prices"("product_id", "price_type_id", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_property_profiles_field_id_key" ON "catalog_property_profiles"("field_id");

-- CreateIndex
CREATE INDEX "catalog_property_profiles_workspace_id_variant_axis_idx" ON "catalog_property_profiles"("workspace_id", "variant_axis");

-- CreateIndex
CREATE INDEX "catalog_product_media_workspace_id_product_id_sort_order_idx" ON "catalog_product_media"("workspace_id", "product_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_product_media_product_id_file_id_key" ON "catalog_product_media"("product_id", "file_id");

-- CreateIndex
CREATE INDEX "commercial_product_rows_workspace_id_owner_type_owner_id_so_idx" ON "commercial_product_rows"("workspace_id", "owner_type", "owner_id", "sort_order");

-- CreateIndex
CREATE INDEX "commercial_product_rows_workspace_id_product_id_idx" ON "commercial_product_rows"("workspace_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "commercial_row_sets_workspace_id_owner_type_owner_id_key" ON "commercial_row_sets"("workspace_id", "owner_type", "owner_id");

-- CreateIndex
CREATE INDEX "outbox_events_automation_processed_at_occurred_at_idx" ON "outbox_events"("automation_processed_at", "occurred_at");


-- ---------------------------------------------------------------------------------------------------------------------
-- Backfill / compatibility: every event that exists before Automation is enabled is marked as already consumed so the
-- consumer can never replay historical CRM events into newly published Rules.
-- ---------------------------------------------------------------------------------------------------------------------
UPDATE "outbox_events" SET "automation_processed_at" = "occurred_at" WHERE "automation_processed_at" IS NULL;

-- ---------------------------------------------------------------------------------------------------------------------
-- Automation invariants that are cheap to state in the database
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_priority_range" CHECK ("priority" BETWEEN 0 AND 100000);
ALTER TABLE "automation_actions" ADD CONSTRAINT "automation_actions_sort_order_nonneg" CHECK ("sort_order" >= 0);
ALTER TABLE "automation_jobs" ADD CONSTRAINT "automation_jobs_counters_nonneg" CHECK ("attempts" >= 0 AND "max_attempts" >= 1 AND "depth" >= 0);
ALTER TABLE "automation_executions" ADD CONSTRAINT "automation_executions_counters_nonneg" CHECK ("retry_count" >= 0 AND "depth" >= 0);

-- Published revisions are immutable: content columns can never change once a revision leaves DRAFT, and the only allowed
-- state transition afterwards is PUBLISHED -> SUPERSEDED.
CREATE OR REPLACE FUNCTION automation_revision_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."state" <> 'DRAFT' THEN
      RAISE EXCEPTION 'AUTOMATION_REVISION_IMMUTABLE: a published revision cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."state" IN ('PUBLISHED', 'SUPERSEDED') THEN
    IF NEW."rule_id" IS DISTINCT FROM OLD."rule_id"
       OR NEW."workspace_id" IS DISTINCT FROM OLD."workspace_id"
       OR NEW."revision_number" IS DISTINCT FROM OLD."revision_number"
       OR NEW."trigger_code" IS DISTINCT FROM OLD."trigger_code"
       OR NEW."trigger_config" IS DISTINCT FROM OLD."trigger_config"
       OR NEW."condition_tree" IS DISTINCT FROM OLD."condition_tree"
       OR NEW."conditions_version" IS DISTINCT FROM OLD."conditions_version"
       OR NEW."timing" IS DISTINCT FROM OLD."timing"
       OR NEW."execution_policy" IS DISTINCT FROM OLD."execution_policy"
       OR NEW."config_hash" IS DISTINCT FROM OLD."config_hash"
       OR NEW."published_at" IS DISTINCT FROM OLD."published_at"
       OR NEW."published_by_user_id" IS DISTINCT FROM OLD."published_by_user_id" THEN
      RAISE EXCEPTION 'AUTOMATION_REVISION_IMMUTABLE: published revision content cannot be modified';
    END IF;
    IF OLD."state" = 'SUPERSEDED' AND NEW."state" <> 'SUPERSEDED' THEN
      RAISE EXCEPTION 'AUTOMATION_REVISION_IMMUTABLE: a superseded revision cannot be reactivated';
    END IF;
    IF OLD."state" = 'PUBLISHED' AND NEW."state" NOT IN ('PUBLISHED', 'SUPERSEDED') THEN
      RAISE EXCEPTION 'AUTOMATION_REVISION_IMMUTABLE: a published revision cannot return to draft';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "automation_rule_revisions_guard"
BEFORE UPDATE OR DELETE ON "automation_rule_revisions"
FOR EACH ROW EXECUTE FUNCTION automation_revision_guard();

-- Actions belong to a revision; once that revision is published its action list is frozen too.
CREATE OR REPLACE FUNCTION automation_action_guard() RETURNS trigger AS $$
DECLARE
  revision_state "AutomationRevisionState";
  target_revision UUID;
BEGIN
  IF TG_OP = 'INSERT' THEN
    target_revision := NEW."revision_id";
  ELSE
    target_revision := OLD."revision_id";
  END IF;
  SELECT "state" INTO revision_state FROM "automation_rule_revisions" WHERE "id" = target_revision;
  IF revision_state IS NOT NULL AND revision_state <> 'DRAFT' THEN
    RAISE EXCEPTION 'AUTOMATION_REVISION_IMMUTABLE: actions of a published revision cannot be changed';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "automation_actions_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "automation_actions"
FOR EACH ROW EXECUTE FUNCTION automation_action_guard();

-- ---------------------------------------------------------------------------------------------------------------------
-- Catalog invariants
-- ---------------------------------------------------------------------------------------------------------------------
-- A Variant always has a parent and only Variants have one; sellable rows carry a SKU, parents never do.
ALTER TABLE "catalog_products" ADD CONSTRAINT "catalog_products_type_shape" CHECK (
  (("type" = 'VARIANT') = ("parent_id" IS NOT NULL))
  AND ("type" <> 'PRODUCT_WITH_VARIANTS' OR "sku_key" IS NULL)
  AND ("type" NOT IN ('SIMPLE_PRODUCT', 'VARIANT') OR "sku_key" IS NOT NULL)
  AND ("axis_key" IS NULL OR "type" = 'VARIANT')
  AND ("parent_id" IS NULL OR "parent_id" <> "id")
);
ALTER TABLE "catalog_products" ADD CONSTRAINT "catalog_products_tax_rate_range" CHECK ("tax_rate" IS NULL OR ("tax_rate" >= 0 AND "tax_rate" <= 100));
ALTER TABLE "catalog_products" ADD CONSTRAINT "catalog_products_dimensions_nonneg" CHECK (
  ("weight" IS NULL OR "weight" >= 0) AND ("length" IS NULL OR "length" >= 0) AND ("width" IS NULL OR "width" >= 0) AND ("height" IS NULL OR "height" >= 0)
);
ALTER TABLE "catalog_categories" ADD CONSTRAINT "catalog_categories_no_self_parent" CHECK ("parent_id" IS NULL OR "parent_id" <> "id");
ALTER TABLE "catalog_product_unit_ratios" ADD CONSTRAINT "catalog_product_unit_ratios_positive" CHECK ("ratio" > 0);
ALTER TABLE "catalog_product_unit_ratios" ADD CONSTRAINT "catalog_product_unit_ratios_distinct_units" CHECK ("unit_id" <> "base_unit_id");
ALTER TABLE "catalog_product_prices" ADD CONSTRAINT "catalog_product_prices_amount_nonneg" CHECK ("amount" >= 0);
ALTER TABLE "catalog_product_prices" ADD CONSTRAINT "catalog_product_prices_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$');

-- Commercial rows are self-contained snapshots; the numbers must always be internally sane.
ALTER TABLE "commercial_product_rows" ADD CONSTRAINT "commercial_product_rows_values_sane" CHECK (
  "quantity" > 0
  AND "unit_price" >= 0
  AND "discount_value" >= 0
  AND "discount_amount" >= 0
  AND "tax_rate" >= 0 AND "tax_rate" <= 100
  AND "subtotal" >= 0 AND "tax_amount" >= 0 AND "total" >= 0
  AND "currency" ~ '^[A-Z]{3}$'
  AND "discount_type" IN ('NONE', 'PERCENT', 'AMOUNT')
);
ALTER TABLE "commercial_product_rows" ADD CONSTRAINT "commercial_product_rows_manual_shape" CHECK (("is_manual" = true) = ("product_id" IS NULL));
