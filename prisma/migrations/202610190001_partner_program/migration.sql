-- DropIndex
DROP INDEX "partner_workspace_relations_workspace_id_is_deleted_key";

-- AlterTable
ALTER TABLE "partner_applications" ADD COLUMN     "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "decided_at" TIMESTAMPTZ(6),
ADD COLUMN     "decision_by" UUID,
ADD COLUMN     "decision_reason" TEXT,
ADD COLUMN     "email_normalized" TEXT,
ADD COLUMN     "privacy_version" TEXT,
ADD COLUMN     "review_flags" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "terms_version" TEXT,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "partners" ADD COLUMN     "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "default_discount_basis_points" INTEGER NOT NULL DEFAULT 1000,
ADD COLUMN     "deleted_at" TIMESTAMPTZ(6),
ADD COLUMN     "purged_at" TIMESTAMPTZ(6),
ADD COLUMN     "source_application_id" UUID,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "partner_roles" ADD COLUMN     "code" TEXT NOT NULL DEFAULT 'CUSTOM',
ADD COLUMN     "partner_id" UUID,
ADD COLUMN     "protected" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "partner_memberships" ADD COLUMN     "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "partner_workspace_relations" ADD COLUMN     "created_by_member_id" UUID,
ADD COLUMN     "customer_owner_consent_ref" TEXT,
ADD COLUMN     "end_reason" TEXT,
ADD COLUMN     "ended_at" TIMESTAMPTZ(6),
ADD COLUMN     "relation_version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "sourced_by_referral_id" UUID,
ADD COLUMN     "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'ACTIVE';

-- CreateTable
CREATE TABLE "partner_approval_events" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "decision" TEXT NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "partner_id" UUID,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_approval_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_role_permissions" (
    "id" UUID NOT NULL,
    "partner_role_id" UUID NOT NULL,
    "permission_code" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'PARTNER_ALL',
    "effect" TEXT NOT NULL DEFAULT 'ALLOW',

    CONSTRAINT "partner_role_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_invitations" (
    "id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "email_hash" TEXT NOT NULL,
    "role_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "invited_by" UUID NOT NULL,
    "accepted_by" UUID,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_discount_rules" (
    "id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT,
    "basis_points" INTEGER NOT NULL,
    "priority_version" INTEGER NOT NULL,
    "valid_from" TIMESTAMPTZ(6) NOT NULL,
    "valid_until" TIMESTAMPTZ(6),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "approved_by" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_discount_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_discount_versions" (
    "id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "immutable_rules_snapshot" JSONB NOT NULL,
    "effective_from" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_discount_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_price_audit" (
    "id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "old_rule_hash" TEXT,
    "new_rule_hash" TEXT,
    "actor_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_price_audit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_workspace_provisioning" (
    "id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "initiating_member_id" UUID NOT NULL,
    "customer_user_id" UUID NOT NULL,
    "workspace_name" TEXT NOT NULL,
    "workspace_id" UUID,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "error_code" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_workspace_provisioning_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_workspace_access" (
    "id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "grantee_user_id" UUID,
    "grant_scope" TEXT NOT NULL DEFAULT 'READ_ONLY',
    "permission_codes" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "reason" TEXT NOT NULL,
    "requested_by" UUID NOT NULL,
    "granted_by_customer_user_id" UUID,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_workspace_access_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_access_events" (
    "id" UUID NOT NULL,
    "grant_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "actor_id" UUID,
    "reason" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_access_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_referral_links" (
    "id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "public_code" TEXT NOT NULL,
    "campaign_label" TEXT NOT NULL,
    "attribution_window_days" INTEGER NOT NULL,
    "model_version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "partner_referral_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_referral_touches" (
    "id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "code_id" UUID NOT NULL,
    "visitor_ref" TEXT NOT NULL,
    "consent_scope" TEXT NOT NULL,
    "observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_referral_touches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_referral_attributions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "source_touch_id" UUID,
    "model_version" INTEGER NOT NULL,
    "effective_at" TIMESTAMPTZ(6) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "dispute_reason" TEXT,
    "reviewed_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_referral_attributions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_relation_transfers" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "from_partner_id" UUID,
    "to_partner_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "requested_by" UUID NOT NULL,
    "customer_owner_consent" TEXT,
    "platform_approval_by" UUID,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "decided_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_relation_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_commission_policies" (
    "id" UUID NOT NULL,
    "partner_id" UUID,
    "product_category" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "fixed_amount" DECIMAL(20,4),
    "basis_points" INTEGER,
    "currency" TEXT NOT NULL,
    "eligibility_rule" JSONB NOT NULL DEFAULT '{}',
    "effective_from" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_commission_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_commissions" (
    "id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "billing_transaction_id" UUID NOT NULL,
    "policy_id" UUID NOT NULL,
    "policy_version" INTEGER NOT NULL,
    "policy_snapshot" JSONB NOT NULL,
    "eligible_base" DECIMAL(20,4) NOT NULL,
    "commission_amount" DECIMAL(20,4) NOT NULL,
    "reversed_amount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "paid_amount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ELIGIBLE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_commissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_commission_ledger" (
    "id" UUID NOT NULL,
    "commission_id" UUID NOT NULL,
    "event_key" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amount" DECIMAL(20,4) NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_commission_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_payout_batches" (
    "id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "period" TEXT NOT NULL,
    "amount" DECIMAL(20,4) NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SUBMITTED',
    "requested_by" UUID NOT NULL,
    "approved_by" UUID,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "payment_provider" TEXT,
    "payment_reference" TEXT,
    "paid_at" TIMESTAMPTZ(6),
    "failure_reason" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_payout_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_payout_items" (
    "id" UUID NOT NULL,
    "payout_batch_id" UUID NOT NULL,
    "commission_id" UUID NOT NULL,
    "settled_amount" DECIMAL(20,4) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "partner_payout_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_payout_events" (
    "id" UUID NOT NULL,
    "payout_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "actor_id" UUID,
    "external_ref" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_payout_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_payout_reconciliation" (
    "id" UUID NOT NULL,
    "payout_id" UUID NOT NULL,
    "evidence_ref" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "difference" DECIMAL(20,4) NOT NULL,
    "checked_by" UUID NOT NULL,
    "checked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_payout_reconciliation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_lifecycle_cases" (
    "id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "operation" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'APPLIED',
    "actor_id" UUID NOT NULL,
    "approval_ref" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_lifecycle_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_access_invalidations" (
    "id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "invalidated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_access_invalidations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_retention_refs" (
    "id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "legal_hold_id" UUID,
    "policy_id" UUID,

    CONSTRAINT "partner_retention_refs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_analytics_facts" (
    "id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "period" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "workspaces_referred" INTEGER NOT NULL DEFAULT 0,
    "eligible_revenue" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "discounts" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "commission_accrual" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "payouts" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "reporting_version" INTEGER NOT NULL DEFAULT 1,
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_analytics_facts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_dashboard_preferences" (
    "id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "saved_filters" JSONB NOT NULL DEFAULT '{}',
    "visibility" TEXT NOT NULL DEFAULT 'PRIVATE',
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_dashboard_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_report_exports" (
    "id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "requester_id" UUID NOT NULL,
    "scope_hash" TEXT NOT NULL,
    "request" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "output_sealed" TEXT,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_report_exports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "partner_approval_events_application_id_idempotency_key_key" ON "partner_approval_events"("application_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "partner_role_permissions_partner_role_id_permission_code_key" ON "partner_role_permissions"("partner_role_id", "permission_code");

-- CreateIndex
CREATE UNIQUE INDEX "partner_invitations_token_hash_key" ON "partner_invitations"("token_hash");

-- CreateIndex
CREATE INDEX "partner_invitations_partner_id_status_idx" ON "partner_invitations"("partner_id", "status");

-- CreateIndex
CREATE INDEX "partner_discount_rules_partner_id_target_type_status_idx" ON "partner_discount_rules"("partner_id", "target_type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "partner_discount_versions_partner_id_version_key" ON "partner_discount_versions"("partner_id", "version");

-- CreateIndex
CREATE INDEX "partner_price_audit_partner_id_idx" ON "partner_price_audit"("partner_id");

-- CreateIndex
CREATE UNIQUE INDEX "partner_workspace_provisioning_partner_id_idempotency_key_key" ON "partner_workspace_provisioning"("partner_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "partner_workspace_access_workspace_id_status_idx" ON "partner_workspace_access"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "partner_workspace_access_partner_id_status_idx" ON "partner_workspace_access"("partner_id", "status");

-- CreateIndex
CREATE INDEX "partner_access_events_grant_id_idx" ON "partner_access_events"("grant_id");

-- CreateIndex
CREATE UNIQUE INDEX "partner_referral_links_code_hash_key" ON "partner_referral_links"("code_hash");

-- CreateIndex
CREATE UNIQUE INDEX "partner_referral_links_public_code_key" ON "partner_referral_links"("public_code");

-- CreateIndex
CREATE INDEX "partner_referral_links_partner_id_status_idx" ON "partner_referral_links"("partner_id", "status");

-- CreateIndex
CREATE INDEX "partner_referral_touches_visitor_ref_observed_at_idx" ON "partner_referral_touches"("visitor_ref", "observed_at");

-- CreateIndex
CREATE INDEX "partner_referral_touches_partner_id_observed_at_idx" ON "partner_referral_touches"("partner_id", "observed_at");

-- CreateIndex
CREATE INDEX "partner_referral_attributions_workspace_id_status_idx" ON "partner_referral_attributions"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "partner_referral_attributions_partner_id_status_idx" ON "partner_referral_attributions"("partner_id", "status");

-- CreateIndex
CREATE INDEX "partner_relation_transfers_workspace_id_status_idx" ON "partner_relation_transfers"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "partner_commission_policies_partner_id_product_category_eff_idx" ON "partner_commission_policies"("partner_id", "product_category", "effective_from");

-- CreateIndex
CREATE INDEX "partner_commissions_partner_id_status_idx" ON "partner_commissions"("partner_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "partner_commissions_billing_transaction_id_policy_id_partne_key" ON "partner_commissions"("billing_transaction_id", "policy_id", "partner_id");

-- CreateIndex
CREATE UNIQUE INDEX "partner_commission_ledger_event_key_key" ON "partner_commission_ledger"("event_key");

-- CreateIndex
CREATE INDEX "partner_commission_ledger_commission_id_idx" ON "partner_commission_ledger"("commission_id");

-- CreateIndex
CREATE INDEX "partner_payout_batches_partner_id_status_idx" ON "partner_payout_batches"("partner_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "partner_payout_batches_partner_id_idempotency_key_key" ON "partner_payout_batches"("partner_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "partner_payout_batches_payment_provider_payment_reference_key" ON "partner_payout_batches"("payment_provider", "payment_reference");

-- CreateIndex
CREATE UNIQUE INDEX "partner_payout_items_commission_id_payout_batch_id_key" ON "partner_payout_items"("commission_id", "payout_batch_id");

-- CreateIndex
CREATE INDEX "partner_payout_events_payout_id_idx" ON "partner_payout_events"("payout_id");

-- CreateIndex
CREATE UNIQUE INDEX "partner_payout_reconciliation_payout_id_key" ON "partner_payout_reconciliation"("payout_id");

-- CreateIndex
CREATE INDEX "partner_lifecycle_cases_partner_id_occurred_at_idx" ON "partner_lifecycle_cases"("partner_id", "occurred_at");

-- CreateIndex
CREATE INDEX "partner_access_invalidations_partner_id_idx" ON "partner_access_invalidations"("partner_id");

-- CreateIndex
CREATE INDEX "partner_retention_refs_partner_id_idx" ON "partner_retention_refs"("partner_id");

-- CreateIndex
CREATE UNIQUE INDEX "partner_analytics_facts_partner_id_period_currency_key" ON "partner_analytics_facts"("partner_id", "period", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "partner_dashboard_preferences_partner_id_user_id_key" ON "partner_dashboard_preferences"("partner_id", "user_id");

-- CreateIndex
CREATE INDEX "partner_report_exports_partner_id_requester_id_idx" ON "partner_report_exports"("partner_id", "requester_id");

-- CreateIndex
CREATE UNIQUE INDEX "partners_source_application_id_key" ON "partners"("source_application_id");

-- CreateIndex
CREATE INDEX "partner_workspace_relations_workspace_id_status_idx" ON "partner_workspace_relations"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "partner_workspace_relations_partner_id_status_idx" ON "partner_workspace_relations"("partner_id", "status");


-- ---------------------------------------------------------------------------------------------
-- Backfill legacy Auth-pack partner rows, then Partner Program invariants.
-- ---------------------------------------------------------------------------------------------
UPDATE "partner_workspace_relations" SET "status" = 'ENDED', "ended_at" = CURRENT_TIMESTAMP WHERE "is_deleted" = true;
UPDATE "partners" SET "default_discount_basis_points" = LEAST(10000, GREATEST(0, "default_discount" * 100));
UPDATE "partner_roles" r SET "code" = 'OWNER', "protected" = true,
  "partner_id" = (SELECT m."partner_id" FROM "partner_memberships" m WHERE m."partner_role_id" = r."id" LIMIT 1)
WHERE r."is_owner_role" = true;
UPDATE "partner_applications" SET "email_normalized" = lower(trim("email")) WHERE "email_normalized" IS NULL;

-- Exactly one ACTIVE commercial Partner relation per Workspace (04 rule 2, 06 AC02).
CREATE UNIQUE INDEX "partner_workspace_relations_one_active" ON "partner_workspace_relations" ("workspace_id") WHERE "status" = 'ACTIVE' AND "is_deleted" = false;
-- One PENDING application per applicant; a commission can sit in only one active payout (08 AC01).
CREATE UNIQUE INDEX "partner_applications_one_pending_per_user" ON "partner_applications" ("user_id") WHERE "status" = 'PENDING' AND "is_deleted" = false;
CREATE UNIQUE INDEX "partner_payout_items_one_active_claim" ON "partner_payout_items" ("commission_id") WHERE "active" = true;
CREATE UNIQUE INDEX "partner_transfers_one_pending" ON "partner_relation_transfers" ("workspace_id") WHERE "status" IN ('PENDING', 'APPROVED');

ALTER TABLE "partner_discount_rules" ADD CONSTRAINT "partner_discount_rules_bps_range" CHECK ("basis_points" BETWEEN 0 AND 10000);
ALTER TABLE "partner_discount_rules" ADD CONSTRAINT "partner_discount_rules_window" CHECK ("valid_until" IS NULL OR "valid_until" > "valid_from");
ALTER TABLE "partners" ADD CONSTRAINT "partners_default_bps_range" CHECK ("default_discount_basis_points" BETWEEN 0 AND 10000);
ALTER TABLE "partner_commission_policies" ADD CONSTRAINT "partner_commission_policy_values" CHECK (("basis_points" IS NULL OR "basis_points" BETWEEN 0 AND 10000) AND ("fixed_amount" IS NULL OR "fixed_amount" >= 0));
ALTER TABLE "partner_commissions" ADD CONSTRAINT "partner_commissions_amounts" CHECK ("commission_amount" >= 0 AND "reversed_amount" >= 0 AND "paid_amount" >= 0 AND "reversed_amount" <= "commission_amount");
ALTER TABLE "partner_payout_batches" ADD CONSTRAINT "partner_payout_amount_positive" CHECK ("amount" > 0);

-- Append-only histories (compensating entries instead of edits).
CREATE OR REPLACE FUNCTION partner_forbid_history_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'PARTNER_HISTORY_IMMUTABLE: % rows are append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER partner_commission_ledger_append_only BEFORE UPDATE OR DELETE ON "partner_commission_ledger" FOR EACH ROW EXECUTE FUNCTION partner_forbid_history_mutation();
CREATE TRIGGER partner_approval_events_append_only BEFORE UPDATE OR DELETE ON "partner_approval_events" FOR EACH ROW EXECUTE FUNCTION partner_forbid_history_mutation();
CREATE TRIGGER partner_access_events_append_only BEFORE UPDATE OR DELETE ON "partner_access_events" FOR EACH ROW EXECUTE FUNCTION partner_forbid_history_mutation();
CREATE TRIGGER partner_payout_events_append_only BEFORE UPDATE OR DELETE ON "partner_payout_events" FOR EACH ROW EXECUTE FUNCTION partner_forbid_history_mutation();
CREATE TRIGGER partner_lifecycle_cases_append_only BEFORE UPDATE OR DELETE ON "partner_lifecycle_cases" FOR EACH ROW EXECUTE FUNCTION partner_forbid_history_mutation();
CREATE TRIGGER partner_discount_versions_append_only BEFORE UPDATE OR DELETE ON "partner_discount_versions" FOR EACH ROW EXECUTE FUNCTION partner_forbid_history_mutation();
CREATE TRIGGER partner_price_audit_append_only BEFORE UPDATE OR DELETE ON "partner_price_audit" FOR EACH ROW EXECUTE FUNCTION partner_forbid_history_mutation();
