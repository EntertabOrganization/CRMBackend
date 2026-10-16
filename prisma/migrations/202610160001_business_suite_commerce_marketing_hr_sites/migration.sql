-- Business suite: Commerce extensions, Marketing Campaigns, HR/Time Tracking, Sites/Landing Pages.
-- Additive only; no existing table or column is rewritten.
ALTER TABLE "commerce_orders" ADD COLUMN "processing_status" TEXT;

-- CreateTable
CREATE TABLE "suite_provider_calls" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "module" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "reference" TEXT,
    "campaign_id" UUID,
    "recipient_key" TEXT,
    "outcome" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suite_provider_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suite_retention_policies" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "module" TEXT NOT NULL,
    "jurisdiction" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "retention_days" INTEGER NOT NULL,
    "effective_from" DATE NOT NULL,
    "legal_basis" TEXT NOT NULL,
    "disposal_method" TEXT NOT NULL,
    "sensitive_fields" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suite_retention_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suite_legal_holds" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "module" TEXT NOT NULL,
    "scope_type" TEXT NOT NULL,
    "scope_id" UUID,
    "reason" TEXT NOT NULL,
    "placed_by_user_id" UUID NOT NULL,
    "placed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMPTZ(6),

    CONSTRAINT "suite_legal_holds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_store_profiles" (
    "store_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'HYBRID',
    "default_locale" TEXT NOT NULL DEFAULT 'en',
    "reservation_ttl_seconds" INTEGER,
    "backorders_enabled" BOOLEAN NOT NULL DEFAULT false,
    "guest_checkout_enabled" BOOLEAN NOT NULL DEFAULT true,
    "orders_create_deals" BOOLEAN NOT NULL DEFAULT false,
    "portal_enabled" BOOLEAN NOT NULL DEFAULT false,
    "invoice_policy" TEXT NOT NULL DEFAULT 'NONE',
    "discount_stacking_mode" TEXT NOT NULL DEFAULT 'PRIORITY',
    "digital_access_policy" JSONB NOT NULL DEFAULT '{}',
    "allowed_return_hosts" JSONB NOT NULL DEFAULT '[]',
    "retention_configured" BOOLEAN NOT NULL DEFAULT false,
    "policy_version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "commerce_store_profiles_pkey" PRIMARY KEY ("store_id")
);

-- CreateTable
CREATE TABLE "commerce_store_channels" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "site_id" UUID,
    "domain_id" UUID,
    "hostname" TEXT,
    "route_prefix" TEXT NOT NULL,
    "api_client_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',

    CONSTRAINT "commerce_store_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_store_categories" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "source_catalog_category_id" UUID,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "parent_id" UUID,
    "sort_rank" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "commerce_store_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_listing_overrides" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "publication_id" UUID NOT NULL,
    "price_type_id" UUID,
    "currency" CHAR(3) NOT NULL,
    "amount" DECIMAL(24,6),
    "valid_from" TIMESTAMPTZ(6),
    "valid_to" TIMESTAMPTZ(6),
    "sort_rank" INTEGER NOT NULL DEFAULT 0,
    "seo_overrides" JSONB NOT NULL DEFAULT '{}',
    "category_ids" JSONB NOT NULL DEFAULT '[]',
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "commerce_listing_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_customer_identities" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "email_normalized" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "verified_at" TIMESTAMPTZ(6),
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "created_by_store_id" UUID NOT NULL,
    "crm_contact_id" UUID,
    "crm_company_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_customer_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_customer_store_memberships" (
    "identity_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_customer_store_memberships_pkey" PRIMARY KEY ("identity_id","store_id")
);

-- CreateTable
CREATE TABLE "commerce_customer_tokens" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "identity_id" UUID,
    "order_id" UUID,
    "purpose" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_customer_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_order_status_definitions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 100,
    "is_protected" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "commerce_order_status_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_order_amendments" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "before_snapshot" JSONB NOT NULL,
    "after_snapshot" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_order_amendments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_payment_intent_refs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "provider_key" TEXT NOT NULL,
    "payment_method_id" TEXT NOT NULL,
    "payment_id" UUID,
    "provider_reference" TEXT,
    "redirect_url" TEXT,
    "return_url" TEXT,
    "amount" DECIMAL(24,6) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CREATED',
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_payment_intent_refs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_fulfillment_exceptions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "payment_ref" TEXT,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolution" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),

    CONSTRAINT "commerce_fulfillment_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_backorder_lines" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "order_line_id" UUID NOT NULL,
    "remaining_qty" DECIMAL(24,6) NOT NULL,
    "expected_date" DATE,
    "state" TEXT NOT NULL DEFAULT 'WAITING',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_backorder_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_fulfillments" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "warehouse_id" UUID,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "lines" JSONB NOT NULL,
    "shipment_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_fulfillments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_checkout_links" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "order_id" UUID,
    "cart_id" UUID,
    "conversation_id" UUID,
    "token_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "issued_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_checkout_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_digital_deliveries" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "order_line_id" UUID NOT NULL,
    "file_id" UUID,
    "license_reference" TEXT,
    "access_state" TEXT NOT NULL DEFAULT 'PENDING',
    "download_limit" INTEGER,
    "download_count" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_digital_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_digital_access_tokens" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "delivery_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_digital_access_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_service_fulfillments" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "order_line_id" UUID NOT NULL,
    "scheduled_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "completed_by_user_id" UUID,

    CONSTRAINT "commerce_service_fulfillments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_operational_alerts" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "details" JSONB NOT NULL DEFAULT '{}',
    "raised_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_operational_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_segments" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'EMAIL',
    "rule_tree" JSONB NOT NULL DEFAULT '{}',
    "exclusions" JSONB NOT NULL DEFAULT '[]',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "owner_user_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "marketing_segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_segment_members" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "segment_id" UUID NOT NULL,
    "identity_ref" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "added_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMPTZ(6),

    CONSTRAINT "marketing_segment_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_audience_identities" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "destination_encrypted" TEXT NOT NULL,
    "destination_hash" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "source_import_id" UUID,
    "crm_contact_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_audience_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_audience_imports" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "segment_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "file_checksum" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "field_mapping" JSONB NOT NULL,
    "duplicate_policy" TEXT NOT NULL,
    "consent_policy" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UPLOADED',
    "imported_count" INTEGER NOT NULL DEFAULT 0,
    "rejected_count" INTEGER NOT NULL DEFAULT 0,
    "created_by_user_id" UUID NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_audience_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_audience_import_rows" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "import_id" UUID NOT NULL,
    "row_number" INTEGER NOT NULL,
    "destination_hash" TEXT,
    "destination_sealed" TEXT,
    "masked_destination" TEXT,
    "error_code" TEXT,
    "identity_id" UUID,
    "duplicate" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "marketing_audience_import_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_audience_snapshots" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "segment_id" UUID NOT NULL,
    "segment_revision" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'BUILDING',
    "target_count" INTEGER NOT NULL DEFAULT 0,
    "checksum" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_audience_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_audience_recipients" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "snapshot_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "recipient_key" TEXT NOT NULL,
    "destination_hash" TEXT NOT NULL,
    "destination_sealed" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "source_ref" TEXT NOT NULL,
    "eligibility_state" TEXT NOT NULL,

    CONSTRAINT "marketing_audience_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_consent_records" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "subject_ref" TEXT,
    "destination_hash" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "lawful_basis" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "evidence_file_id" UUID,
    "jurisdiction" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "effective_at" TIMESTAMPTZ(6) NOT NULL,
    "recorded_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_consent_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_suppressions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "destination_hash" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6),
    "lifted_at" TIMESTAMPTZ(6),
    "created_by_user_id" UUID,

    CONSTRAINT "marketing_suppressions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_consent_policies" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "jurisdiction" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "consent_required" BOOLEAN NOT NULL DEFAULT true,
    "quiet_hours" JSONB NOT NULL DEFAULT '{}',
    "frequency_cap" JSONB NOT NULL DEFAULT '{}',
    "rules_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_consent_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_optout_tokens" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "destination_hash" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "campaign_id" UUID,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),

    CONSTRAINT "marketing_optout_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_provider_connections" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "ownership" TEXT NOT NULL,
    "credential_secret_ref" TEXT NOT NULL,
    "credential_mask" TEXT NOT NULL,
    "webhook_secret_ref" TEXT,
    "region" TEXT,
    "quotas" JSONB NOT NULL DEFAULT '{}',
    "capabilities" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "health" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "last_health_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_provider_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_sender_identities" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "provider_connection_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "verification_token_hash" TEXT,
    "verified_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_sender_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_templates" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "latest_version_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_template_versions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "subject" TEXT,
    "body_markup" TEXT,
    "body_text" TEXT NOT NULL,
    "provider_template" TEXT,
    "variable_schema" JSONB NOT NULL DEFAULT '{}',
    "checksum" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "created_by_user_id" UUID NOT NULL,
    "approved_by_user_id" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_template_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_campaigns" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'MARKETING',
    "jurisdiction" TEXT NOT NULL DEFAULT 'DEFAULT',
    "segment_id" UUID NOT NULL,
    "sender_identity_id" UUID,
    "template_version_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "scheduled_at" TIMESTAMPTZ(6),
    "scheduled_local" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "approved_revision" INTEGER,
    "content_hash" TEXT NOT NULL,
    "audience_snapshot_id" UUID,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "estimated_recipients" INTEGER NOT NULL DEFAULT 0,
    "created_by_user_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "launched_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_campaign_approvals" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "requester_user_id" UUID NOT NULL,
    "approver_user_id" UUID,
    "state" TEXT NOT NULL DEFAULT 'REQUESTED',
    "reason" TEXT,
    "risk_level" TEXT NOT NULL DEFAULT 'STANDARD',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ(6),

    CONSTRAINT "marketing_campaign_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_campaign_schedules" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "run_at" TIMESTAMPTZ(6) NOT NULL,
    "execution_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "lease_token" TEXT,
    "lease_expires_at" TIMESTAMPTZ(6),
    "executed_at" TIMESTAMPTZ(6),

    CONSTRAINT "marketing_campaign_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_deliveries" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "recipient_id" UUID,
    "recipient_key" TEXT NOT NULL,
    "destination_hash" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL DEFAULT '',
    "template_version_id" UUID NOT NULL,
    "sender_identity_id" UUID NOT NULL,
    "provider_connection_id" UUID NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'QUEUED',
    "is_test" BOOLEAN NOT NULL DEFAULT false,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error_code" TEXT,
    "provider_message_id" TEXT,
    "lease_token" TEXT,
    "lease_expires_at" TIMESTAMPTZ(6),
    "sent_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "marketing_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_delivery_attempts" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "delivery_id" UUID NOT NULL,
    "attempt_no" INTEGER NOT NULL,
    "provider_request_id" TEXT NOT NULL,
    "provider_message_id" TEXT,
    "response_code" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_delivery_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_provider_events" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "provider_event_id" TEXT NOT NULL,
    "delivery_id" UUID,
    "status" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_provider_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_engagement_events" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "delivery_id" UUID,
    "recipient_key" TEXT,
    "provider_event_id" TEXT,
    "type" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "source" TEXT NOT NULL,
    "confidence" TEXT NOT NULL,
    "unique_key" TEXT NOT NULL,
    "is_unique" BOOLEAN NOT NULL DEFAULT true,
    "suspected_bot" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "marketing_engagement_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_tracking_links" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "delivery_id" UUID,
    "variant_id" TEXT NOT NULL DEFAULT '',
    "destination_url" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "consent_category" TEXT NOT NULL,

    CONSTRAINT "marketing_tracking_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_experiments" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "metric" TEXT NOT NULL,
    "min_sample" INTEGER NOT NULL,
    "seed" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "winning_variant_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_experiments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_variants" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "experiment_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "template_version_id" UUID NOT NULL,
    "percentage" DECIMAL(6,2) NOT NULL,
    "assigned_recipients" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "marketing_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_journeys" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "workflow_definition_id" UUID NOT NULL,
    "workflow_version_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "reentry_policy" TEXT NOT NULL DEFAULT 'PROHIBIT_ACTIVE',
    "created_by_user_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_journeys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_journey_enrollments" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "journey_id" UUID NOT NULL,
    "subject_key" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "workflow_execution_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "error_code" TEXT,
    "source_event_id" TEXT,
    "entered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_journey_enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_ad_connections" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "platform" TEXT NOT NULL,
    "credential_secret_ref" TEXT NOT NULL,
    "credential_mask" TEXT NOT NULL,
    "external_account_id" TEXT NOT NULL,
    "sandbox" BOOLEAN NOT NULL DEFAULT false,
    "state" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_ad_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_ad_audiences" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "segment_id" UUID NOT NULL,
    "platform" TEXT NOT NULL,
    "external_audience_id" TEXT,
    "synced_hashes" JSONB NOT NULL DEFAULT '[]',
    "last_sync_at" TIMESTAMPTZ(6),
    "sync_state" TEXT NOT NULL DEFAULT 'PENDING',
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "marketing_ad_audiences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_ad_sync_jobs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "audience_id" UUID NOT NULL,
    "source_revision" INTEGER NOT NULL,
    "added_count" INTEGER NOT NULL DEFAULT 0,
    "removed_count" INTEGER NOT NULL DEFAULT 0,
    "rejected_count" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "error_code" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "marketing_ad_sync_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_ad_metric_imports" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "platform" TEXT NOT NULL,
    "external_campaign_id" TEXT NOT NULL,
    "period_from" DATE NOT NULL,
    "period_to" DATE NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "spend" DECIMAL(24,6) NOT NULL,
    "impressions" INTEGER NOT NULL,
    "clicks" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_ad_metric_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_repeat_sale_rules" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "trigger_event" TEXT NOT NULL,
    "segment_id" UUID NOT NULL,
    "journey_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_repeat_sale_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_positions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "grade" TEXT,

    CONSTRAINT "hr_positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_employees" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "user_id" UUID,
    "employee_number" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'INVITED',
    "display_name" TEXT NOT NULL,
    "department_id" UUID,
    "manager_employee_id" UUID,
    "position_id" UUID,
    "work_location_id" UUID,
    "employment_type" TEXT NOT NULL DEFAULT 'FULL_TIME',
    "timezone" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "private_sealed" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hr_employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_employment_records" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "employment_type" TEXT NOT NULL,
    "position_id" UUID,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,

    CONSTRAINT "hr_employment_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_work_locations" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "allowed_networks" JSONB NOT NULL DEFAULT '[]',
    "geo_rules" JSONB,
    "qr_required" BOOLEAN NOT NULL DEFAULT false,
    "qr_secret_ref" TEXT,

    CONSTRAINT "hr_work_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_schedules" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hr_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_schedule_versions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "schedule_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "rules" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hr_schedule_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_schedule_assignments" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "schedule_version_id" UUID NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,

    CONSTRAINT "hr_schedule_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_shifts" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "schedule_version_id" UUID,
    "start_at" TIMESTAMPTZ(6) NOT NULL,
    "end_at" TIMESTAMPTZ(6) NOT NULL,
    "capacity" INTEGER NOT NULL,
    "location_id" UUID,
    "department_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'PUBLISHED',

    CONSTRAINT "hr_shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_shift_assignments" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "shift_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ASSIGNED',

    CONSTRAINT "hr_shift_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_work_sessions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "shift_id" UUID,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "ended_at" TIMESTAMPTZ(6),
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "source" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "hr_work_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_work_events" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL,
    "idempotency_key" TEXT,
    "correction_id" UUID,
    "supersedes_event_id" UUID,
    "recorded_by_user_id" UUID NOT NULL,

    CONSTRAINT "hr_work_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_breaks" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "ended_at" TIMESTAMPTZ(6),
    "kind" TEXT NOT NULL DEFAULT 'UNPAID',

    CONSTRAINT "hr_breaks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_attendance_evidence" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "encrypted_payload" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hr_attendance_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_attendance_corrections" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "work_session_id" UUID,
    "target_date" DATE NOT NULL,
    "proposed_events" JSONB NOT NULL,
    "reason_sealed" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "requested_by_user_id" UUID NOT NULL,
    "reviewed_by_user_id" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "applied_at" TIMESTAMPTZ(6),
    "override" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hr_attendance_corrections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_correction_history" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "correction_id" UUID NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "applied_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hr_correction_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_timesheets" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "timezone" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "totals" JSONB NOT NULL DEFAULT '{}',
    "policy_versions" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "submitted_at" TIMESTAMPTZ(6),
    "approved_at" TIMESTAMPTZ(6),
    "locked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hr_timesheets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_timesheet_lines" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "timesheet_id" UUID NOT NULL,
    "work_date" DATE NOT NULL,
    "source_session_ids" JSONB NOT NULL,
    "scheduled_minutes" INTEGER NOT NULL,
    "worked_minutes" INTEGER NOT NULL,
    "unpaid_break_minutes" INTEGER NOT NULL,
    "overtime_minutes" INTEGER NOT NULL,
    "leave_minutes" INTEGER NOT NULL,
    "anomaly_codes" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "hr_timesheet_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_timesheet_reviews" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "timesheet_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "decision" TEXT NOT NULL,
    "comment" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hr_timesheet_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_overtime_policies" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "work_location_id" UUID,
    "thresholds" JSONB NOT NULL,
    "eligible_employment_types" JSONB NOT NULL,
    "count_leave_as_worked" BOOLEAN NOT NULL DEFAULT false,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "hr_overtime_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_overtime_entries" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "work_date" DATE NOT NULL,
    "period_key" TEXT NOT NULL,
    "rule" TEXT NOT NULL,
    "minutes" INTEGER NOT NULL,
    "policy_id" UUID,
    "policy_version" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'CALCULATED',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hr_overtime_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_overtime_approvals" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "entry_id" UUID NOT NULL,
    "entry_version" INTEGER NOT NULL,
    "reviewer_user_id" UUID NOT NULL,
    "decision" TEXT NOT NULL,
    "comment" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hr_overtime_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_leave_types" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "paid" BOOLEAN NOT NULL,
    "requires_balance" BOOLEAN NOT NULL,
    "approval_chain" JSONB NOT NULL DEFAULT '["MANAGER"]',

    CONSTRAINT "hr_leave_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_leave_policies" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "leave_type_id" UUID NOT NULL,
    "location_id" UUID,
    "accrual_rule" JSONB NOT NULL,
    "carry_over_rule" JSONB NOT NULL,
    "negative_allowed" BOOLEAN NOT NULL DEFAULT false,
    "holidays" JSONB NOT NULL DEFAULT '[]',
    "lead_time_days" INTEGER NOT NULL DEFAULT 0,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "hr_leave_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_leave_accounts" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "leave_type_id" UUID NOT NULL,
    "period" TEXT NOT NULL,
    "unit" TEXT NOT NULL,

    CONSTRAINT "hr_leave_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_leave_ledger" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "units" DECIMAL(12,4) NOT NULL,
    "source_id" UUID,
    "idempotency_key" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "policy_version" INTEGER,
    "note" TEXT,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hr_leave_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_leave_requests" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "leave_type_id" UUID NOT NULL,
    "from_local" DATE NOT NULL,
    "to_local" DATE NOT NULL,
    "part_day_minutes" INTEGER,
    "timezone" TEXT NOT NULL,
    "requested_units" DECIMAL(12,4) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "reason_sealed" TEXT,
    "approval_chain" JSONB NOT NULL DEFAULT '[]',
    "current_step" INTEGER NOT NULL DEFAULT 0,
    "policy_version" INTEGER,
    "workflow_execution_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "idempotency_key" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hr_leave_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_leave_approvals" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "approver_user_id" UUID NOT NULL,
    "step_index" INTEGER NOT NULL,
    "decision" TEXT NOT NULL,
    "breakglass" BOOLEAN NOT NULL DEFAULT false,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hr_leave_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_absence_projections" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'FREE_BUSY',
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "hr_absence_projections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_work_reports" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "period_type" TEXT NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "summary" TEXT NOT NULL,
    "achievements" TEXT NOT NULL DEFAULT '',
    "blockers" TEXT NOT NULL DEFAULT '',
    "task_ids" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hr_work_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_work_report_reviews" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "reviewer_user_id" UUID NOT NULL,
    "decision" TEXT NOT NULL,
    "comment" TEXT,
    "snapshot" JSONB NOT NULL,
    "reviewed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hr_work_report_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_lifecycle_cases" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "effective_date" DATE NOT NULL,
    "workflow_execution_id" UUID,
    "status" TEXT NOT NULL,
    "checklist" JSONB NOT NULL DEFAULT '[]',
    "created_by_user_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hr_lifecycle_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_document_bindings" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "confidentiality" TEXT NOT NULL,
    "expires_at" DATE,
    "removed_at" TIMESTAMPTZ(6),
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hr_document_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_access_transitions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "user_id" UUID,
    "effective_at" TIMESTAMPTZ(6) NOT NULL,
    "action" TEXT NOT NULL,
    "execution_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "error_code" TEXT,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "hr_access_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_access_audits" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "fields" JSONB NOT NULL,
    "reason" TEXT,
    "event_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hr_access_audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sites" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "subdomain" TEXT NOT NULL,
    "default_locale" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "site_version" INTEGER NOT NULL DEFAULT 1,
    "active_release_id" UUID,
    "requires_approval" BOOLEAN NOT NULL DEFAULT false,
    "store_id" UUID,
    "archived_at" TIMESTAMPTZ(6),
    "recover_before" TIMESTAMPTZ(6),
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_domains" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "hostname" TEXT NOT NULL,
    "verification_token_hash" TEXT NOT NULL,
    "verification_state" TEXT NOT NULL DEFAULT 'PENDING',
    "certificate_state" TEXT NOT NULL DEFAULT 'NONE',
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "verified_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_domains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_host_routes" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "domain_id" UUID,
    "hostname" TEXT NOT NULL,
    "path_prefix" TEXT NOT NULL,
    "store_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',

    CONSTRAINT "site_host_routes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_folders" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "parent_id" UUID,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "site_folders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_pages" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "parent_folder_id" UUID,
    "parent_key" TEXT NOT NULL DEFAULT '',
    "slug" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sort_rank" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "latest_revision" INTEGER NOT NULL DEFAULT 0,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by_user_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_page_revisions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "page_id" UUID NOT NULL,
    "locale" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "block_tree" JSONB NOT NULL,
    "seo" JSONB NOT NULL DEFAULT '{}',
    "content_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "origin" TEXT NOT NULL DEFAULT 'EDITOR',
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_page_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_navigation_menus" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "site_navigation_menus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_content_entries" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "author_user_id" UUID NOT NULL,
    "publication_state" TEXT NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_content_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_redirects" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "from_path" TEXT NOT NULL,
    "to_path" TEXT NOT NULL,
    "status_code" INTEGER NOT NULL,
    "reason" TEXT NOT NULL DEFAULT 'MANUAL',

    CONSTRAINT "site_redirects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_shared_blocks" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "owner_site_id" UUID,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "latest_revision" INTEGER NOT NULL DEFAULT 0,
    "published_revision" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_shared_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_shared_block_revisions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "shared_block_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "props" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_shared_block_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_themes" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "tokens" JSONB NOT NULL,
    "breakpoints" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_themes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_releases" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "release_number" INTEGER NOT NULL,
    "manifest" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "approval_state" TEXT NOT NULL DEFAULT 'NOT_REQUIRED',
    "approved_by_user_id" UUID,
    "scheduled_at" TIMESTAMPTZ(6),
    "activated_at" TIMESTAMPTZ(6),
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_releases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_preview_tokens" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "release_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "password_hash" TEXT,
    "audience_scope" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "created_by_user_id" UUID NOT NULL,

    CONSTRAINT "site_preview_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_languages" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "locale" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "fallback_policy" TEXT NOT NULL DEFAULT 'DEFAULT_LANGUAGE',
    "rtl" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "site_languages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_translations" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "source_page_id" UUID NOT NULL,
    "target_page_id" UUID NOT NULL,
    "source_revision_id" UUID NOT NULL,
    "draft_revision_id" UUID NOT NULL,
    "source_locale" TEXT NOT NULL,
    "target_locale" TEXT NOT NULL,
    "ai_draft_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "reviewed_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_translations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_seo_settings" (
    "site_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "robots_default" TEXT NOT NULL DEFAULT 'index,follow',
    "sitemap_enabled" BOOLEAN NOT NULL DEFAULT true,
    "default_og_image_file_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "site_seo_settings_pkey" PRIMARY KEY ("site_id")
);

-- CreateTable
CREATE TABLE "site_sitemap_builds" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "release_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'BUILDING',
    "content" TEXT NOT NULL DEFAULT '',
    "generated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_sitemap_builds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_performance_metrics" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "page_id" UUID NOT NULL,
    "release_id" UUID NOT NULL,
    "lcp" DOUBLE PRECISION,
    "cls" DOUBLE PRECISION,
    "ttfb" DOUBLE PRECISION,
    "measured_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_performance_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_module_bindings" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "page_id" UUID NOT NULL,
    "block_key" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "external_resource_id" UUID NOT NULL,
    "public_settings" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "last_checked_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "site_module_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_cookie_policies" (
    "site_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "categories" JSONB NOT NULL,
    "jurisdiction_rules" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "site_cookie_policies_pkey" PRIMARY KEY ("site_id")
);

-- CreateTable
CREATE TABLE "site_consent_preferences" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "visitor_key" TEXT NOT NULL,
    "consent_version" INTEGER NOT NULL,
    "accepted_categories" JSONB NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_consent_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_scripts" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "source_hash" TEXT NOT NULL,
    "allowed_category" TEXT NOT NULL,
    "origin_allowlist" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'REVIEW',
    "requested_by_user_id" UUID NOT NULL,
    "approved_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_scripts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_experiments" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "page_id" UUID NOT NULL,
    "metric" TEXT NOT NULL,
    "goal_event" TEXT NOT NULL,
    "attribution_window_hours" INTEGER NOT NULL DEFAULT 24,
    "seed" TEXT NOT NULL,
    "persist_assignments" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "start_at" TIMESTAMPTZ(6),
    "end_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "site_experiments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_experiment_variants" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "experiment_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "page_revision_id" UUID NOT NULL,
    "traffic_percent" DECIMAL(6,2) NOT NULL,

    CONSTRAINT "site_experiment_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_visitor_assignments" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "experiment_id" UUID NOT NULL,
    "visitor_key" TEXT NOT NULL,
    "variant_id" UUID NOT NULL,
    "assigned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_visitor_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_experiment_events" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "experiment_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "visitor_key" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "consent_state" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_experiment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_ai_drafts" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "page_id" UUID,
    "scenario" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "generated_revision_id" UUID,
    "model_id" TEXT,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_micros" BIGINT NOT NULL DEFAULT 0,
    "usage_key" TEXT NOT NULL,
    "billed" BOOLEAN NOT NULL DEFAULT false,
    "error_code" TEXT,
    "requested_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_ai_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_export_jobs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "release_id" UUID,
    "format" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "content" JSONB,
    "download_token_hash" TEXT,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "requested_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_export_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "suite_provider_calls_idempotency_key_key" ON "suite_provider_calls"("idempotency_key");

-- CreateIndex
CREATE INDEX "suite_provider_calls_workspace_id_module_created_at_idx" ON "suite_provider_calls"("workspace_id", "module", "created_at");

-- CreateIndex
CREATE INDEX "suite_provider_calls_workspace_id_campaign_id_recipient_key_idx" ON "suite_provider_calls"("workspace_id", "campaign_id", "recipient_key");

-- CreateIndex
CREATE UNIQUE INDEX "suite_retention_policies_workspace_id_module_jurisdiction_c_key" ON "suite_retention_policies"("workspace_id", "module", "jurisdiction", "category", "effective_from");

-- CreateIndex
CREATE INDEX "suite_legal_holds_workspace_id_module_scope_type_scope_id_idx" ON "suite_legal_holds"("workspace_id", "module", "scope_type", "scope_id");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_store_profiles_workspace_id_slug_key" ON "commerce_store_profiles"("workspace_id", "slug");

-- CreateIndex
CREATE INDEX "commerce_store_channels_workspace_id_store_id_idx" ON "commerce_store_channels"("workspace_id", "store_id");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_store_channels_hostname_route_prefix_key" ON "commerce_store_channels"("hostname", "route_prefix");

-- CreateIndex
CREATE INDEX "commerce_store_categories_workspace_id_store_id_idx" ON "commerce_store_categories"("workspace_id", "store_id");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_store_categories_store_id_slug_key" ON "commerce_store_categories"("store_id", "slug");

-- CreateIndex
CREATE INDEX "commerce_listing_overrides_workspace_id_store_id_idx" ON "commerce_listing_overrides"("workspace_id", "store_id");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_listing_overrides_workspace_id_publication_id_key" ON "commerce_listing_overrides"("workspace_id", "publication_id");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_customer_identities_workspace_id_email_normalized_key" ON "commerce_customer_identities"("workspace_id", "email_normalized");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_customer_tokens_token_hash_key" ON "commerce_customer_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "commerce_customer_tokens_workspace_id_order_id_idx" ON "commerce_customer_tokens"("workspace_id", "order_id");

-- CreateIndex
CREATE INDEX "commerce_customer_tokens_workspace_id_identity_id_purpose_idx" ON "commerce_customer_tokens"("workspace_id", "identity_id", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_order_status_definitions_store_id_code_key" ON "commerce_order_status_definitions"("store_id", "code");

-- CreateIndex
CREATE INDEX "commerce_order_amendments_workspace_id_order_id_created_at_idx" ON "commerce_order_amendments"("workspace_id", "order_id", "created_at");

-- CreateIndex
CREATE INDEX "commerce_payment_intent_refs_workspace_id_order_id_status_idx" ON "commerce_payment_intent_refs"("workspace_id", "order_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_payment_intent_refs_workspace_id_order_id_idempote_key" ON "commerce_payment_intent_refs"("workspace_id", "order_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "commerce_fulfillment_exceptions_workspace_id_order_id_statu_idx" ON "commerce_fulfillment_exceptions"("workspace_id", "order_id", "status");

-- CreateIndex
CREATE INDEX "commerce_backorder_lines_workspace_id_order_id_idx" ON "commerce_backorder_lines"("workspace_id", "order_id");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_backorder_lines_workspace_id_order_line_id_key" ON "commerce_backorder_lines"("workspace_id", "order_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_fulfillments_shipment_id_key" ON "commerce_fulfillments"("shipment_id");

-- CreateIndex
CREATE INDEX "commerce_fulfillments_workspace_id_order_id_status_idx" ON "commerce_fulfillments"("workspace_id", "order_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_checkout_links_token_hash_key" ON "commerce_checkout_links"("token_hash");

-- CreateIndex
CREATE INDEX "commerce_checkout_links_workspace_id_order_id_idx" ON "commerce_checkout_links"("workspace_id", "order_id");

-- CreateIndex
CREATE INDEX "commerce_digital_deliveries_workspace_id_order_id_idx" ON "commerce_digital_deliveries"("workspace_id", "order_id");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_digital_deliveries_workspace_id_order_line_id_key" ON "commerce_digital_deliveries"("workspace_id", "order_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_digital_access_tokens_token_hash_key" ON "commerce_digital_access_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "commerce_digital_access_tokens_workspace_id_delivery_id_idx" ON "commerce_digital_access_tokens"("workspace_id", "delivery_id");

-- CreateIndex
CREATE INDEX "commerce_service_fulfillments_workspace_id_order_id_idx" ON "commerce_service_fulfillments"("workspace_id", "order_id");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_service_fulfillments_workspace_id_order_line_id_key" ON "commerce_service_fulfillments"("workspace_id", "order_line_id");

-- CreateIndex
CREATE INDEX "commerce_operational_alerts_workspace_id_store_id_status_idx" ON "commerce_operational_alerts"("workspace_id", "store_id", "status");

-- CreateIndex
CREATE INDEX "marketing_segments_workspace_id_status_created_at_idx" ON "marketing_segments"("workspace_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "marketing_segment_members_workspace_id_segment_id_idx" ON "marketing_segment_members"("workspace_id", "segment_id");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_segment_members_segment_id_identity_ref_key" ON "marketing_segment_members"("segment_id", "identity_ref");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_audience_identities_workspace_id_channel_destinat_key" ON "marketing_audience_identities"("workspace_id", "channel", "destination_hash");

-- CreateIndex
CREATE INDEX "marketing_audience_imports_workspace_id_segment_id_idx" ON "marketing_audience_imports"("workspace_id", "segment_id");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_audience_imports_workspace_id_file_checksum_idemp_key" ON "marketing_audience_imports"("workspace_id", "file_checksum", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_audience_import_rows_import_id_row_number_key" ON "marketing_audience_import_rows"("import_id", "row_number");

-- CreateIndex
CREATE INDEX "marketing_audience_snapshots_workspace_id_campaign_id_idx" ON "marketing_audience_snapshots"("workspace_id", "campaign_id");

-- CreateIndex
CREATE INDEX "marketing_audience_recipients_workspace_id_campaign_id_idx" ON "marketing_audience_recipients"("workspace_id", "campaign_id");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_audience_recipients_snapshot_id_destination_hash__key" ON "marketing_audience_recipients"("snapshot_id", "destination_hash", "channel");

-- CreateIndex
CREATE INDEX "marketing_consent_records_workspace_id_destination_hash_cha_idx" ON "marketing_consent_records"("workspace_id", "destination_hash", "channel", "purpose", "effective_at");

-- CreateIndex
CREATE INDEX "marketing_suppressions_workspace_id_destination_hash_channe_idx" ON "marketing_suppressions"("workspace_id", "destination_hash", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_consent_policies_workspace_id_jurisdiction_channe_key" ON "marketing_consent_policies"("workspace_id", "jurisdiction", "channel", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_optout_tokens_token_hash_key" ON "marketing_optout_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "marketing_provider_connections_workspace_id_channel_status_idx" ON "marketing_provider_connections"("workspace_id", "channel", "status");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_sender_identities_workspace_id_channel_address_key" ON "marketing_sender_identities"("workspace_id", "channel", "address");

-- CreateIndex
CREATE INDEX "marketing_templates_workspace_id_channel_status_idx" ON "marketing_templates"("workspace_id", "channel", "status");

-- CreateIndex
CREATE INDEX "marketing_template_versions_workspace_id_template_id_idx" ON "marketing_template_versions"("workspace_id", "template_id");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_template_versions_template_id_version_no_key" ON "marketing_template_versions"("template_id", "version_no");

-- CreateIndex
CREATE INDEX "marketing_campaigns_workspace_id_status_created_at_idx" ON "marketing_campaigns"("workspace_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "marketing_campaign_approvals_workspace_id_campaign_id_revis_idx" ON "marketing_campaign_approvals"("workspace_id", "campaign_id", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_campaign_schedules_execution_key_key" ON "marketing_campaign_schedules"("execution_key");

-- CreateIndex
CREATE INDEX "marketing_campaign_schedules_status_run_at_idx" ON "marketing_campaign_schedules"("status", "run_at");

-- CreateIndex
CREATE INDEX "marketing_deliveries_state_next_attempt_at_idx" ON "marketing_deliveries"("state", "next_attempt_at");

-- CreateIndex
CREATE INDEX "marketing_deliveries_workspace_id_campaign_id_state_idx" ON "marketing_deliveries"("workspace_id", "campaign_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_deliveries_campaign_id_recipient_key_channel_vari_key" ON "marketing_deliveries"("campaign_id", "recipient_key", "channel", "variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_delivery_attempts_delivery_id_attempt_no_key" ON "marketing_delivery_attempts"("delivery_id", "attempt_no");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_provider_events_connection_id_provider_event_id_key" ON "marketing_provider_events"("connection_id", "provider_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_engagement_events_unique_key_key" ON "marketing_engagement_events"("unique_key");

-- CreateIndex
CREATE INDEX "marketing_engagement_events_workspace_id_campaign_id_type_idx" ON "marketing_engagement_events"("workspace_id", "campaign_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_tracking_links_token_hash_key" ON "marketing_tracking_links"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_experiments_campaign_id_key" ON "marketing_experiments"("campaign_id");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_variants_experiment_id_label_key" ON "marketing_variants"("experiment_id", "label");

-- CreateIndex
CREATE INDEX "marketing_journey_enrollments_workspace_id_journey_id_subje_idx" ON "marketing_journey_enrollments"("workspace_id", "journey_id", "subject_key", "status");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_ad_connections_workspace_id_platform_external_acc_key" ON "marketing_ad_connections"("workspace_id", "platform", "external_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_ad_audiences_connection_id_segment_id_key" ON "marketing_ad_audiences"("connection_id", "segment_id");

-- CreateIndex
CREATE INDEX "marketing_ad_sync_jobs_status_next_attempt_at_idx" ON "marketing_ad_sync_jobs"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_ad_metric_imports_workspace_id_platform_external__key" ON "marketing_ad_metric_imports"("workspace_id", "platform", "external_campaign_id", "period_from", "period_to", "checksum");

-- CreateIndex
CREATE UNIQUE INDEX "hr_positions_workspace_id_title_key" ON "hr_positions"("workspace_id", "title");

-- CreateIndex
CREATE INDEX "hr_employees_workspace_id_user_id_status_idx" ON "hr_employees"("workspace_id", "user_id", "status");

-- CreateIndex
CREATE INDEX "hr_employees_workspace_id_department_id_idx" ON "hr_employees"("workspace_id", "department_id");

-- CreateIndex
CREATE UNIQUE INDEX "hr_employees_workspace_id_employee_number_key" ON "hr_employees"("workspace_id", "employee_number");

-- CreateIndex
CREATE INDEX "hr_employment_records_workspace_id_employee_id_idx" ON "hr_employment_records"("workspace_id", "employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "hr_work_locations_workspace_id_name_key" ON "hr_work_locations"("workspace_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "hr_schedules_workspace_id_name_key" ON "hr_schedules"("workspace_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "hr_schedule_versions_schedule_id_version_no_key" ON "hr_schedule_versions"("schedule_id", "version_no");

-- CreateIndex
CREATE INDEX "hr_schedule_assignments_workspace_id_employee_id_effective__idx" ON "hr_schedule_assignments"("workspace_id", "employee_id", "effective_from");

-- CreateIndex
CREATE INDEX "hr_shifts_workspace_id_start_at_idx" ON "hr_shifts"("workspace_id", "start_at");

-- CreateIndex
CREATE UNIQUE INDEX "hr_shift_assignments_shift_id_employee_id_key" ON "hr_shift_assignments"("shift_id", "employee_id");

-- CreateIndex
CREATE INDEX "hr_work_sessions_workspace_id_employee_id_status_idx" ON "hr_work_sessions"("workspace_id", "employee_id", "status");

-- CreateIndex
CREATE INDEX "hr_work_sessions_workspace_id_employee_id_started_at_idx" ON "hr_work_sessions"("workspace_id", "employee_id", "started_at");

-- CreateIndex
CREATE INDEX "hr_work_events_workspace_id_session_id_occurred_at_idx" ON "hr_work_events"("workspace_id", "session_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "hr_work_events_workspace_id_employee_id_idempotency_key_key" ON "hr_work_events"("workspace_id", "employee_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "hr_breaks_workspace_id_session_id_idx" ON "hr_breaks"("workspace_id", "session_id");

-- CreateIndex
CREATE INDEX "hr_attendance_evidence_workspace_id_event_id_idx" ON "hr_attendance_evidence"("workspace_id", "event_id");

-- CreateIndex
CREATE INDEX "hr_attendance_corrections_workspace_id_employee_id_status_idx" ON "hr_attendance_corrections"("workspace_id", "employee_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "hr_correction_history_correction_id_key" ON "hr_correction_history"("correction_id");

-- CreateIndex
CREATE UNIQUE INDEX "hr_timesheets_workspace_id_employee_id_period_start_period__key" ON "hr_timesheets"("workspace_id", "employee_id", "period_start", "period_end");

-- CreateIndex
CREATE UNIQUE INDEX "hr_timesheet_lines_timesheet_id_work_date_key" ON "hr_timesheet_lines"("timesheet_id", "work_date");

-- CreateIndex
CREATE UNIQUE INDEX "hr_timesheet_reviews_timesheet_id_revision_decision_key" ON "hr_timesheet_reviews"("timesheet_id", "revision", "decision");

-- CreateIndex
CREATE INDEX "hr_overtime_policies_workspace_id_effective_from_idx" ON "hr_overtime_policies"("workspace_id", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "hr_overtime_entries_workspace_id_employee_id_period_key_rul_key" ON "hr_overtime_entries"("workspace_id", "employee_id", "period_key", "rule");

-- CreateIndex
CREATE UNIQUE INDEX "hr_overtime_approvals_entry_id_entry_version_decision_key" ON "hr_overtime_approvals"("entry_id", "entry_version", "decision");

-- CreateIndex
CREATE UNIQUE INDEX "hr_leave_types_workspace_id_name_key" ON "hr_leave_types"("workspace_id", "name");

-- CreateIndex
CREATE INDEX "hr_leave_policies_workspace_id_leave_type_id_effective_from_idx" ON "hr_leave_policies"("workspace_id", "leave_type_id", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "hr_leave_accounts_workspace_id_employee_id_leave_type_id_pe_key" ON "hr_leave_accounts"("workspace_id", "employee_id", "leave_type_id", "period");

-- CreateIndex
CREATE INDEX "hr_leave_ledger_workspace_id_employee_id_kind_active_idx" ON "hr_leave_ledger"("workspace_id", "employee_id", "kind", "active");

-- CreateIndex
CREATE UNIQUE INDEX "hr_leave_ledger_account_id_idempotency_key_key" ON "hr_leave_ledger"("account_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "hr_leave_requests_workspace_id_employee_id_status_idx" ON "hr_leave_requests"("workspace_id", "employee_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "hr_leave_requests_workspace_id_employee_id_idempotency_key_key" ON "hr_leave_requests"("workspace_id", "employee_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "hr_leave_approvals_request_id_step_index_key" ON "hr_leave_approvals"("request_id", "step_index");

-- CreateIndex
CREATE UNIQUE INDEX "hr_absence_projections_request_id_key" ON "hr_absence_projections"("request_id");

-- CreateIndex
CREATE INDEX "hr_absence_projections_workspace_id_start_date_end_date_idx" ON "hr_absence_projections"("workspace_id", "start_date", "end_date");

-- CreateIndex
CREATE INDEX "hr_work_reports_workspace_id_employee_id_period_start_idx" ON "hr_work_reports"("workspace_id", "employee_id", "period_start");

-- CreateIndex
CREATE UNIQUE INDEX "hr_work_report_reviews_report_id_revision_key" ON "hr_work_report_reviews"("report_id", "revision");

-- CreateIndex
CREATE INDEX "hr_lifecycle_cases_workspace_id_employee_id_kind_idx" ON "hr_lifecycle_cases"("workspace_id", "employee_id", "kind");

-- CreateIndex
CREATE INDEX "hr_document_bindings_workspace_id_employee_id_idx" ON "hr_document_bindings"("workspace_id", "employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "hr_access_transitions_execution_key_key" ON "hr_access_transitions"("execution_key");

-- CreateIndex
CREATE INDEX "hr_access_transitions_status_next_attempt_at_idx" ON "hr_access_transitions"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "hr_access_audits_workspace_id_employee_id_event_at_idx" ON "hr_access_audits"("workspace_id", "employee_id", "event_at");

-- CreateIndex
CREATE UNIQUE INDEX "sites_subdomain_key" ON "sites"("subdomain");

-- CreateIndex
CREATE INDEX "sites_workspace_id_status_idx" ON "sites"("workspace_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "site_domains_hostname_key" ON "site_domains"("hostname");

-- CreateIndex
CREATE INDEX "site_domains_workspace_id_site_id_idx" ON "site_domains"("workspace_id", "site_id");

-- CreateIndex
CREATE INDEX "site_host_routes_workspace_id_site_id_idx" ON "site_host_routes"("workspace_id", "site_id");

-- CreateIndex
CREATE UNIQUE INDEX "site_host_routes_hostname_path_prefix_key" ON "site_host_routes"("hostname", "path_prefix");

-- CreateIndex
CREATE INDEX "site_folders_workspace_id_site_id_idx" ON "site_folders"("workspace_id", "site_id");

-- CreateIndex
CREATE INDEX "site_pages_workspace_id_site_id_status_idx" ON "site_pages"("workspace_id", "site_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "site_pages_site_id_locale_parent_key_slug_key" ON "site_pages"("site_id", "locale", "parent_key", "slug");

-- CreateIndex
CREATE INDEX "site_page_revisions_workspace_id_site_id_status_idx" ON "site_page_revisions"("workspace_id", "site_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "site_page_revisions_page_id_revision_key" ON "site_page_revisions"("page_id", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "site_navigation_menus_site_id_name_locale_key" ON "site_navigation_menus"("site_id", "name", "locale");

-- CreateIndex
CREATE UNIQUE INDEX "site_content_entries_site_id_kind_locale_slug_key" ON "site_content_entries"("site_id", "kind", "locale", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "site_redirects_site_id_from_path_key" ON "site_redirects"("site_id", "from_path");

-- CreateIndex
CREATE INDEX "site_shared_blocks_workspace_id_owner_site_id_idx" ON "site_shared_blocks"("workspace_id", "owner_site_id");

-- CreateIndex
CREATE UNIQUE INDEX "site_shared_block_revisions_shared_block_id_revision_key" ON "site_shared_block_revisions"("shared_block_id", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "site_themes_site_id_revision_key" ON "site_themes"("site_id", "revision");

-- CreateIndex
CREATE INDEX "site_releases_workspace_id_site_id_status_idx" ON "site_releases"("workspace_id", "site_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "site_releases_site_id_release_number_key" ON "site_releases"("site_id", "release_number");

-- CreateIndex
CREATE UNIQUE INDEX "site_preview_tokens_token_hash_key" ON "site_preview_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "site_preview_tokens_workspace_id_site_id_idx" ON "site_preview_tokens"("workspace_id", "site_id");

-- CreateIndex
CREATE UNIQUE INDEX "site_languages_site_id_locale_key" ON "site_languages"("site_id", "locale");

-- CreateIndex
CREATE INDEX "site_translations_workspace_id_site_id_status_idx" ON "site_translations"("workspace_id", "site_id", "status");

-- CreateIndex
CREATE INDEX "site_sitemap_builds_workspace_id_site_id_generated_at_idx" ON "site_sitemap_builds"("workspace_id", "site_id", "generated_at");

-- CreateIndex
CREATE INDEX "site_performance_metrics_workspace_id_site_id_measured_at_idx" ON "site_performance_metrics"("workspace_id", "site_id", "measured_at");

-- CreateIndex
CREATE INDEX "site_module_bindings_workspace_id_site_id_idx" ON "site_module_bindings"("workspace_id", "site_id");

-- CreateIndex
CREATE INDEX "site_consent_preferences_workspace_id_site_id_visitor_key_idx" ON "site_consent_preferences"("workspace_id", "site_id", "visitor_key");

-- CreateIndex
CREATE INDEX "site_scripts_workspace_id_site_id_status_idx" ON "site_scripts"("workspace_id", "site_id", "status");

-- CreateIndex
CREATE INDEX "site_experiments_workspace_id_site_id_status_idx" ON "site_experiments"("workspace_id", "site_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "site_experiment_variants_experiment_id_label_key" ON "site_experiment_variants"("experiment_id", "label");

-- CreateIndex
CREATE UNIQUE INDEX "site_visitor_assignments_experiment_id_visitor_key_key" ON "site_visitor_assignments"("experiment_id", "visitor_key");

-- CreateIndex
CREATE UNIQUE INDEX "site_experiment_events_experiment_id_visitor_key_event_type_key" ON "site_experiment_events"("experiment_id", "visitor_key", "event_type");

-- CreateIndex
CREATE UNIQUE INDEX "site_ai_drafts_usage_key_key" ON "site_ai_drafts"("usage_key");

-- CreateIndex
CREATE INDEX "site_ai_drafts_workspace_id_site_id_idx" ON "site_ai_drafts"("workspace_id", "site_id");

-- CreateIndex
CREATE UNIQUE INDEX "site_export_jobs_download_token_hash_key" ON "site_export_jobs"("download_token_hash");

-- CreateIndex
CREATE INDEX "site_export_jobs_workspace_id_site_id_idx" ON "site_export_jobs"("workspace_id", "site_id");

