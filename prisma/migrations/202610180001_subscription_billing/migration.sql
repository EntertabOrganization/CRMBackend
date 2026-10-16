-- CreateTable
CREATE TABLE "billing_plans" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_plan_versions" (
    "id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "sellable" BOOLEAN NOT NULL DEFAULT true,
    "trial_days" INTEGER,
    "published_at" TIMESTAMPTZ(6),
    "retired_at" TIMESTAMPTZ(6),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_plan_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_prices" (
    "id" UUID NOT NULL,
    "plan_version_id" UUID NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" DECIMAL(20,4) NOT NULL,
    "period" TEXT NOT NULL,
    "effective_at" TIMESTAMPTZ(6) NOT NULL,
    "provider_price_ref" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_entitlement_definitions" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "value_type" TEXT NOT NULL,
    "default_value" JSONB NOT NULL,
    "quota_kind" TEXT NOT NULL DEFAULT 'NONE',
    "min_value" DECIMAL(24,6),
    "max_value" DECIMAL(24,6),
    "description" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "billing_entitlement_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_plan_entitlements" (
    "id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "definition_id" UUID NOT NULL,
    "value" JSONB NOT NULL,

    CONSTRAINT "billing_plan_entitlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_entitlement_overrides" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "definition_id" UUID NOT NULL,
    "value" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "approval_id" UUID,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by" UUID,

    CONSTRAINT "billing_entitlement_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_effective_entitlements" (
    "workspace_id" UUID NOT NULL,
    "values" JSONB NOT NULL,
    "source_subscription_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_effective_entitlements_pkey" PRIMARY KEY ("workspace_id")
);

-- CreateTable
CREATE TABLE "billing_entitlement_history" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "values" JSONB NOT NULL,
    "cause" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_entitlement_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_accounts" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "payer_type" TEXT NOT NULL,
    "payer_customer_ref" TEXT,
    "partner_id" UUID,
    "legal_identity_snapshot" JSONB NOT NULL,
    "billing_currency" TEXT NOT NULL,
    "billing_timezone" TEXT NOT NULL DEFAULT 'UTC',
    "tax_profile" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_subscriptions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "billing_account_id" UUID,
    "plan_version_id" UUID NOT NULL,
    "price_id" UUID,
    "status" TEXT NOT NULL,
    "current_period_start" TIMESTAMPTZ(6),
    "current_period_end" TIMESTAMPTZ(6),
    "trial_end" TIMESTAMPTZ(6),
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "cancel_reason" TEXT,
    "grace_until" TIMESTAMPTZ(6),
    "renewal_count" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_trials" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "identity_fingerprint_hash" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',

    CONSTRAINT "billing_trials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_subscription_changes" (
    "id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "change_type" TEXT NOT NULL,
    "from_plan_version_id" UUID,
    "to_plan_version_id" UUID NOT NULL,
    "to_price_id" UUID,
    "quote_id" UUID,
    "effective_at" TIMESTAMPTZ(6) NOT NULL,
    "proration_snapshot" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL,
    "requested_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "applied_at" TIMESTAMPTZ(6),

    CONSTRAINT "billing_subscription_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_quotes" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "subscription_id" UUID,
    "from_plan_version_id" UUID,
    "to_plan_version_id" UUID,
    "price_id" UUID,
    "topup_product_id" UUID,
    "payer_account_id" UUID NOT NULL,
    "requested_timing" TEXT NOT NULL DEFAULT 'IMMEDIATE',
    "effective_at" TIMESTAMPTZ(6) NOT NULL,
    "subtotal" DECIMAL(20,4) NOT NULL,
    "discount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "credits" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "tax" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "total" DECIMAL(20,4) NOT NULL,
    "currency" TEXT NOT NULL,
    "lines" JSONB NOT NULL,
    "price_fingerprint" TEXT NOT NULL,
    "calculation_version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'QUOTED',
    "idempotency_key" TEXT,
    "created_by" UUID,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_compatibility_checks" (
    "id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "target_version_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "performed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_compatibility_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_compatibility_findings" (
    "id" UUID NOT NULL,
    "check_id" UUID NOT NULL,
    "feature_code" TEXT NOT NULL,
    "current_usage" DECIMAL(24,6) NOT NULL,
    "target_limit" DECIMAL(24,6),
    "severity" TEXT NOT NULL,
    "action_policy" TEXT NOT NULL,

    CONSTRAINT "billing_compatibility_findings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_invoices" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "billing_account_id" UUID NOT NULL,
    "subscription_id" UUID,
    "quote_id" UUID,
    "number" TEXT,
    "kind" TEXT NOT NULL,
    "issued_at" TIMESTAMPTZ(6),
    "due_at" TIMESTAMPTZ(6),
    "period_start" TIMESTAMPTZ(6),
    "period_end" TIMESTAMPTZ(6),
    "currency" TEXT NOT NULL,
    "subtotal" DECIMAL(20,4) NOT NULL,
    "discount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "tax" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "total" DECIMAL(20,4) NOT NULL,
    "paid" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "refunded" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "legal_owner" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_invoice_lines" (
    "id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(24,6) NOT NULL,
    "unit_price" DECIMAL(20,4) NOT NULL,
    "discount_basis_points" INTEGER NOT NULL DEFAULT 0,
    "discount_amount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "tax" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "subtotal" DECIMAL(20,4) NOT NULL,
    "kind" TEXT NOT NULL,

    CONSTRAINT "billing_invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_provider_events" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_event_id" TEXT NOT NULL,
    "payload_digest" TEXT NOT NULL,
    "signature_state" TEXT NOT NULL,
    "kind" TEXT,
    "transaction_ref" TEXT,
    "result" TEXT,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),

    CONSTRAINT "billing_provider_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_payment_attempts" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "amount" DECIMAL(20,4) NOT NULL,
    "currency" TEXT NOT NULL,
    "transaction_ref" TEXT,
    "checkout_url" TEXT,
    "status" TEXT NOT NULL DEFAULT 'CREATED',
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_payment_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_payments" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "attempt_id" UUID,
    "provider" TEXT NOT NULL,
    "provider_transaction_id" TEXT NOT NULL,
    "amount" DECIMAL(20,4) NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_refunds" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "amount" DECIMAL(20,4) NOT NULL,
    "currency" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "provider_refund_ref" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "approval_id" UUID,
    "requested_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "billing_refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_usage_meters" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "entitlement_code" TEXT NOT NULL,
    "window_start" TIMESTAMPTZ(6) NOT NULL,
    "window_end" TIMESTAMPTZ(6) NOT NULL,
    "limit_value" DECIMAL(24,6),
    "spent" DECIMAL(24,6) NOT NULL DEFAULT 0,
    "reserved" DECIMAL(24,6) NOT NULL DEFAULT 0,
    "overage" DECIMAL(24,6) NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "billing_usage_meters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_usage_reservations" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "meter_id" UUID NOT NULL,
    "operation_key" TEXT NOT NULL,
    "source_module" TEXT NOT NULL,
    "estimate" DECIMAL(24,6) NOT NULL,
    "overage_units" DECIMAL(24,6) NOT NULL DEFAULT 0,
    "actual" DECIMAL(24,6),
    "status" TEXT NOT NULL DEFAULT 'RESERVED',
    "credit_reservation_id" UUID,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "billing_usage_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_usage_events" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "meter_id" UUID NOT NULL,
    "reservation_id" UUID,
    "event_key" TEXT NOT NULL,
    "quantity" DECIMAL(24,6) NOT NULL,
    "source_module" TEXT NOT NULL,
    "source_ref" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_usage_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_overage_policies" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "rate" DECIMAL(20,6) NOT NULL,
    "currency" TEXT NOT NULL,
    "hard_cap" DECIMAL(24,6) NOT NULL,
    "accepted_price_version" TEXT NOT NULL,
    "acceptance_ref" TEXT NOT NULL,
    "accepted_by" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_overage_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_overage_rates" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "rate" DECIMAL(20,6) NOT NULL,
    "currency" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_overage_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_credit_accounts" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "credit_type" TEXT NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'CREDIT',
    "policy_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_credit_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_credit_grants" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "source_ref" TEXT NOT NULL,
    "initial_units" DECIMAL(24,6) NOT NULL,
    "remaining_units" DECIMAL(24,6) NOT NULL,
    "held_units" DECIMAL(24,6) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "eligible_scenarios" JSONB NOT NULL DEFAULT '[]',
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6),

    CONSTRAINT "billing_credit_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_credit_ledger_entries" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "grant_id" UUID,
    "event_key" TEXT NOT NULL,
    "entry_type" TEXT NOT NULL,
    "quantity" DECIMAL(24,6) NOT NULL,
    "related_run_ref" TEXT,
    "reason" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_credit_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_credit_reservations" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "run_id" TEXT NOT NULL,
    "operation_key" TEXT NOT NULL,
    "scenario" TEXT NOT NULL,
    "allocations" JSONB NOT NULL,
    "reserved_units" DECIMAL(24,6) NOT NULL,
    "consumed_units" DECIMAL(24,6),
    "status" TEXT NOT NULL DEFAULT 'RESERVED',
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_credit_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_topup_products" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "credit_type" TEXT NOT NULL DEFAULT 'AI',
    "units" DECIMAL(24,6) NOT NULL,
    "price" DECIMAL(20,4) NOT NULL,
    "currency" TEXT NOT NULL,
    "expires_in_days" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_topup_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_recovery_cases" (
    "id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "invoice_id" UUID,
    "failure_reason_code" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "grace_until" TIMESTAMPTZ(6) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "resolved_at" TIMESTAMPTZ(6),

    CONSTRAINT "billing_recovery_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_dunning_actions" (
    "id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "scheduled_at" TIMESTAMPTZ(6) NOT NULL,
    "channel" TEXT NOT NULL,
    "delivery_state" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "provider_ref" TEXT,
    "idempotency_key" TEXT NOT NULL,

    CONSTRAINT "billing_dunning_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_service_continuity" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "feature" TEXT NOT NULL,
    "existing_read_policy" TEXT NOT NULL,
    "new_write_policy" TEXT NOT NULL,
    "effective_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "billing_service_continuity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_partner_price_snapshots" (
    "id" UUID NOT NULL,
    "quote_id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "partner_relation_id" UUID NOT NULL,
    "rule_id" TEXT,
    "rule_version" INTEGER NOT NULL,
    "base_price" DECIMAL(20,4) NOT NULL,
    "discount_basis_points" INTEGER NOT NULL,
    "discount_amount" DECIMAL(20,4) NOT NULL,
    "final_amount" DECIMAL(20,4) NOT NULL,
    "currency" TEXT NOT NULL,
    "calculated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_partner_price_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_partner_transactions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "payer_account_id" UUID NOT NULL,
    "partner_id" UUID,
    "invoice_id" UUID NOT NULL,
    "amount" DECIMAL(20,4) NOT NULL,
    "currency" TEXT NOT NULL,
    "commercial_relation_snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_partner_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_partner_credit_adjustments" (
    "id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "related_refund_id" UUID,
    "adjustment_type" TEXT NOT NULL,
    "amount" DECIMAL(20,4) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_partner_credit_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_payer_transitions" (
    "id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "from_account_id" UUID,
    "to_account_id" UUID NOT NULL,
    "customer_owner_consent_ref" TEXT NOT NULL,
    "approval_id" UUID NOT NULL,
    "requested_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_payer_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_reconciliation_runs" (
    "id" UUID NOT NULL,
    "provider_id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "run_scope" TEXT NOT NULL DEFAULT 'FULL',
    "cursor" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "discrepancies_count" INTEGER NOT NULL DEFAULT 0,
    "requested_by" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "billing_reconciliation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_reconciliation_findings" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "finding_key" TEXT NOT NULL,
    "provider_event_ref" TEXT,
    "internal_ref" TEXT,
    "discrepancy_type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "details" JSONB NOT NULL DEFAULT '{}',
    "resolution" TEXT,
    "reason" TEXT,
    "resolved_by" UUID,
    "resolved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_reconciliation_findings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_mrr_facts" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "period" TEXT NOT NULL,
    "effective_plan_version_id" UUID NOT NULL,
    "currency" TEXT NOT NULL,
    "mrr_local" DECIMAL(20,4) NOT NULL,
    "reporting_currency" TEXT NOT NULL,
    "fx_rate_snapshot" DECIMAL(20,10) NOT NULL,
    "mrr_reporting" DECIMAL(20,4) NOT NULL,
    "partner_id_snapshot" UUID,
    "status" TEXT NOT NULL,
    "source_event_ids" JSONB NOT NULL DEFAULT '[]',
    "formula_version" INTEGER NOT NULL DEFAULT 1,
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_mrr_facts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_fx_rates" (
    "id" UUID NOT NULL,
    "period" TEXT NOT NULL,
    "base" TEXT NOT NULL,
    "quote" TEXT NOT NULL,
    "rate" DECIMAL(20,10) NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_fx_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_change_approvals" (
    "id" UUID NOT NULL,
    "workspace_id" UUID,
    "action" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "requester_id" UUID NOT NULL,
    "approver_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "reason" TEXT NOT NULL,
    "decision_at" TIMESTAMPTZ(6),
    "consumed_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_change_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_customer_preferences" (
    "workspace_id" UUID NOT NULL,
    "invoice_delivery_email" TEXT,
    "currency" TEXT,
    "tax_profile_version" INTEGER NOT NULL DEFAULT 1,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_customer_preferences_pkey" PRIMARY KEY ("workspace_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "billing_plans_code_key" ON "billing_plans"("code");

-- CreateIndex
CREATE INDEX "billing_plan_versions_status_idx" ON "billing_plan_versions"("status");

-- CreateIndex
CREATE UNIQUE INDEX "billing_plan_versions_plan_id_version_key" ON "billing_plan_versions"("plan_id", "version");

-- CreateIndex
CREATE INDEX "billing_prices_plan_version_id_currency_period_effective_at_idx" ON "billing_prices"("plan_version_id", "currency", "period", "effective_at");

-- CreateIndex
CREATE UNIQUE INDEX "billing_entitlement_definitions_code_key" ON "billing_entitlement_definitions"("code");

-- CreateIndex
CREATE UNIQUE INDEX "billing_plan_entitlements_version_id_definition_id_key" ON "billing_plan_entitlements"("version_id", "definition_id");

-- CreateIndex
CREATE INDEX "billing_entitlement_overrides_workspace_id_expires_at_idx" ON "billing_entitlement_overrides"("workspace_id", "expires_at");

-- CreateIndex
CREATE INDEX "billing_entitlement_history_workspace_id_occurred_at_idx" ON "billing_entitlement_history"("workspace_id", "occurred_at");

-- CreateIndex
CREATE INDEX "billing_accounts_workspace_id_idx" ON "billing_accounts"("workspace_id");

-- CreateIndex
CREATE INDEX "billing_accounts_partner_id_idx" ON "billing_accounts"("partner_id");

-- CreateIndex
CREATE INDEX "billing_subscriptions_workspace_id_status_idx" ON "billing_subscriptions"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "billing_subscriptions_status_current_period_end_idx" ON "billing_subscriptions"("status", "current_period_end");

-- CreateIndex
CREATE UNIQUE INDEX "billing_trials_identity_fingerprint_hash_key" ON "billing_trials"("identity_fingerprint_hash");

-- CreateIndex
CREATE UNIQUE INDEX "billing_trials_workspace_id_key" ON "billing_trials"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_subscription_changes_quote_id_key" ON "billing_subscription_changes"("quote_id");

-- CreateIndex
CREATE INDEX "billing_subscription_changes_subscription_id_status_idx" ON "billing_subscription_changes"("subscription_id", "status");

-- CreateIndex
CREATE INDEX "billing_subscription_changes_status_effective_at_idx" ON "billing_subscription_changes"("status", "effective_at");

-- CreateIndex
CREATE INDEX "billing_quotes_workspace_id_kind_status_idx" ON "billing_quotes"("workspace_id", "kind", "status");

-- CreateIndex
CREATE INDEX "billing_compatibility_checks_subscription_id_idx" ON "billing_compatibility_checks"("subscription_id");

-- CreateIndex
CREATE INDEX "billing_compatibility_findings_check_id_idx" ON "billing_compatibility_findings"("check_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_invoices_quote_id_key" ON "billing_invoices"("quote_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_invoices_number_key" ON "billing_invoices"("number");

-- CreateIndex
CREATE INDEX "billing_invoices_workspace_id_status_idx" ON "billing_invoices"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "billing_invoices_billing_account_id_idx" ON "billing_invoices"("billing_account_id");

-- CreateIndex
CREATE INDEX "billing_invoices_subscription_id_kind_idx" ON "billing_invoices"("subscription_id", "kind");

-- CreateIndex
CREATE INDEX "billing_invoice_lines_invoice_id_idx" ON "billing_invoice_lines"("invoice_id");

-- CreateIndex
CREATE INDEX "billing_provider_events_provider_received_at_idx" ON "billing_provider_events"("provider", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "billing_provider_events_provider_provider_event_id_key" ON "billing_provider_events"("provider", "provider_event_id");

-- CreateIndex
CREATE INDEX "billing_payment_attempts_provider_transaction_ref_idx" ON "billing_payment_attempts"("provider", "transaction_ref");

-- CreateIndex
CREATE INDEX "billing_payment_attempts_status_created_at_idx" ON "billing_payment_attempts"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "billing_payment_attempts_workspace_id_idempotency_key_key" ON "billing_payment_attempts"("workspace_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "billing_payments_invoice_id_idx" ON "billing_payments"("invoice_id");

-- CreateIndex
CREATE INDEX "billing_payments_occurred_at_idx" ON "billing_payments"("occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "billing_payments_provider_provider_transaction_id_key" ON "billing_payments"("provider", "provider_transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_refunds_idempotency_key_key" ON "billing_refunds"("idempotency_key");

-- CreateIndex
CREATE INDEX "billing_refunds_payment_id_idx" ON "billing_refunds"("payment_id");

-- CreateIndex
CREATE INDEX "billing_refunds_created_at_idx" ON "billing_refunds"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "billing_usage_meters_workspace_id_entitlement_code_window_s_key" ON "billing_usage_meters"("workspace_id", "entitlement_code", "window_start");

-- CreateIndex
CREATE INDEX "billing_usage_reservations_status_expires_at_idx" ON "billing_usage_reservations"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "billing_usage_reservations_workspace_id_meter_id_operation__key" ON "billing_usage_reservations"("workspace_id", "meter_id", "operation_key");

-- CreateIndex
CREATE UNIQUE INDEX "billing_usage_events_event_key_key" ON "billing_usage_events"("event_key");

-- CreateIndex
CREATE INDEX "billing_usage_events_workspace_id_occurred_at_idx" ON "billing_usage_events"("workspace_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "billing_overage_policies_workspace_id_code_key" ON "billing_overage_policies"("workspace_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "billing_overage_rates_code_version_currency_key" ON "billing_overage_rates"("code", "version", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "billing_credit_accounts_workspace_id_credit_type_key" ON "billing_credit_accounts"("workspace_id", "credit_type");

-- CreateIndex
CREATE INDEX "billing_credit_grants_account_id_status_expires_at_idx" ON "billing_credit_grants"("account_id", "status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "billing_credit_grants_account_id_source_ref_key" ON "billing_credit_grants"("account_id", "source_ref");

-- CreateIndex
CREATE UNIQUE INDEX "billing_credit_ledger_entries_event_key_key" ON "billing_credit_ledger_entries"("event_key");

-- CreateIndex
CREATE INDEX "billing_credit_ledger_entries_account_id_occurred_at_idx" ON "billing_credit_ledger_entries"("account_id", "occurred_at");

-- CreateIndex
CREATE INDEX "billing_credit_reservations_status_expires_at_idx" ON "billing_credit_reservations"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "billing_credit_reservations_account_id_operation_key_key" ON "billing_credit_reservations"("account_id", "operation_key");

-- CreateIndex
CREATE UNIQUE INDEX "billing_topup_products_code_key" ON "billing_topup_products"("code");

-- CreateIndex
CREATE INDEX "billing_recovery_cases_status_grace_until_idx" ON "billing_recovery_cases"("status", "grace_until");

-- CreateIndex
CREATE INDEX "billing_recovery_cases_subscription_id_idx" ON "billing_recovery_cases"("subscription_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_dunning_actions_idempotency_key_key" ON "billing_dunning_actions"("idempotency_key");

-- CreateIndex
CREATE INDEX "billing_dunning_actions_delivery_state_scheduled_at_idx" ON "billing_dunning_actions"("delivery_state", "scheduled_at");

-- CreateIndex
CREATE UNIQUE INDEX "billing_service_continuity_workspace_id_feature_key" ON "billing_service_continuity"("workspace_id", "feature");

-- CreateIndex
CREATE UNIQUE INDEX "billing_partner_price_snapshots_quote_id_key" ON "billing_partner_price_snapshots"("quote_id");

-- CreateIndex
CREATE INDEX "billing_partner_price_snapshots_partner_id_idx" ON "billing_partner_price_snapshots"("partner_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_partner_transactions_invoice_id_key" ON "billing_partner_transactions"("invoice_id");

-- CreateIndex
CREATE INDEX "billing_partner_transactions_partner_id_created_at_idx" ON "billing_partner_transactions"("partner_id", "created_at");

-- CreateIndex
CREATE INDEX "billing_partner_transactions_workspace_id_idx" ON "billing_partner_transactions"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_partner_credit_adjustments_related_refund_id_key" ON "billing_partner_credit_adjustments"("related_refund_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_payer_transitions_approval_id_key" ON "billing_payer_transitions"("approval_id");

-- CreateIndex
CREATE INDEX "billing_payer_transitions_subscription_id_idx" ON "billing_payer_transitions"("subscription_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_reconciliation_runs_provider_id_period_run_scope_key" ON "billing_reconciliation_runs"("provider_id", "period", "run_scope");

-- CreateIndex
CREATE INDEX "billing_reconciliation_findings_status_idx" ON "billing_reconciliation_findings"("status");

-- CreateIndex
CREATE UNIQUE INDEX "billing_reconciliation_findings_run_id_finding_key_key" ON "billing_reconciliation_findings"("run_id", "finding_key");

-- CreateIndex
CREATE INDEX "billing_mrr_facts_period_idx" ON "billing_mrr_facts"("period");

-- CreateIndex
CREATE UNIQUE INDEX "billing_mrr_facts_subscription_id_period_key" ON "billing_mrr_facts"("subscription_id", "period");

-- CreateIndex
CREATE UNIQUE INDEX "billing_fx_rates_period_base_quote_key" ON "billing_fx_rates"("period", "base", "quote");

-- CreateIndex
CREATE INDEX "billing_change_approvals_workspace_id_status_idx" ON "billing_change_approvals"("workspace_id", "status");


-- ---------------------------------------------------------------------------------------------
-- Billing invariants that Prisma cannot express.
-- ---------------------------------------------------------------------------------------------
-- One effective (non-terminal) SaaS subscription per Workspace.
CREATE UNIQUE INDEX "billing_subscriptions_one_live_per_workspace" ON "billing_subscriptions" ("workspace_id") WHERE "status" NOT IN ('CANCELLED', 'EXPIRED');
-- One open recovery case per subscription; one pending scheduled change per subscription.
CREATE UNIQUE INDEX "billing_recovery_cases_one_open" ON "billing_recovery_cases" ("subscription_id") WHERE "status" = 'OPEN';
CREATE UNIQUE INDEX "billing_subscription_changes_one_scheduled" ON "billing_subscription_changes" ("subscription_id") WHERE "status" IN ('SCHEDULED', 'PAYMENT_PENDING');
-- One renewal invoice per subscription period.
CREATE UNIQUE INDEX "billing_invoices_one_renewal_per_period" ON "billing_invoices" ("subscription_id", "period_start") WHERE "kind" = 'RENEWAL';

ALTER TABLE "billing_prices" ADD CONSTRAINT "billing_prices_amount_nonnegative" CHECK ("amount" >= 0);
ALTER TABLE "billing_invoices" ADD CONSTRAINT "billing_invoices_amounts_valid" CHECK ("total" >= 0 AND "paid" >= 0 AND "refunded" >= 0 AND "refunded" <= "paid");
ALTER TABLE "billing_payments" ADD CONSTRAINT "billing_payments_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "billing_refunds" ADD CONSTRAINT "billing_refunds_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "billing_usage_meters" ADD CONSTRAINT "billing_usage_meters_nonnegative" CHECK ("spent" >= 0 AND "reserved" >= 0 AND "overage" >= 0);
ALTER TABLE "billing_credit_grants" ADD CONSTRAINT "billing_credit_grants_balance_valid" CHECK ("remaining_units" >= 0 AND "held_units" >= 0 AND "held_units" <= "remaining_units" AND "remaining_units" <= "initial_units");
ALTER TABLE "billing_partner_price_snapshots" ADD CONSTRAINT "billing_partner_bps_range" CHECK ("discount_basis_points" BETWEEN 0 AND 10000);
ALTER TABLE "billing_invoice_lines" ADD CONSTRAINT "billing_invoice_lines_bps_range" CHECK ("discount_basis_points" BETWEEN 0 AND 10000);

-- Append-only financial ledgers (reversals/refunds are compensating rows).
CREATE OR REPLACE FUNCTION billing_forbid_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'BILLING_LEDGER_IMMUTABLE: % rows are append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER billing_credit_ledger_append_only BEFORE UPDATE OR DELETE ON "billing_credit_ledger_entries" FOR EACH ROW EXECUTE FUNCTION billing_forbid_ledger_mutation();
CREATE TRIGGER billing_usage_events_append_only BEFORE UPDATE OR DELETE ON "billing_usage_events" FOR EACH ROW EXECUTE FUNCTION billing_forbid_ledger_mutation();
CREATE TRIGGER billing_payments_append_only BEFORE UPDATE OR DELETE ON "billing_payments" FOR EACH ROW EXECUTE FUNCTION billing_forbid_ledger_mutation();
CREATE TRIGGER billing_partner_price_snapshots_append_only BEFORE UPDATE OR DELETE ON "billing_partner_price_snapshots" FOR EACH ROW EXECUTE FUNCTION billing_forbid_ledger_mutation();
CREATE TRIGGER billing_mrr_fx_rates_append_only BEFORE UPDATE OR DELETE ON "billing_fx_rates" FOR EACH ROW EXECUTE FUNCTION billing_forbid_ledger_mutation();

-- Published plan versions are immutable: entitlements and price rows may change only while the version is DRAFT.
CREATE OR REPLACE FUNCTION billing_forbid_published_plan_mutation() RETURNS trigger AS $$
DECLARE version_status text;
BEGIN
  SELECT status INTO version_status FROM billing_plan_versions WHERE id = CASE TG_TABLE_NAME WHEN 'billing_prices' THEN OLD.plan_version_id ELSE OLD.version_id END;
  IF version_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'BILLING_PLAN_VERSION_IMMUTABLE: published plan versions cannot be rewritten';
  END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER billing_plan_entitlements_immutable BEFORE UPDATE OR DELETE ON "billing_plan_entitlements" FOR EACH ROW EXECUTE FUNCTION billing_forbid_published_plan_mutation();
CREATE TRIGGER billing_prices_immutable BEFORE UPDATE OR DELETE ON "billing_prices" FOR EACH ROW EXECUTE FUNCTION billing_forbid_published_plan_mutation();
