-- CRM Lead enrichment, existing-customer links, conversion history and idempotency.

CREATE TYPE "CrmLeadConversionStatus" AS ENUM ('NOT_CONVERTED', 'CONVERTED');

ALTER TABLE "crm_leads"
ADD COLUMN "first_name" TEXT,
ADD COLUMN "last_name" TEXT,
ADD COLUMN "company_name" TEXT,
ADD COLUMN "company_id" UUID,
ADD COLUMN "conversion_status" "CrmLeadConversionStatus" NOT NULL DEFAULT 'NOT_CONVERTED',
ADD COLUMN "converted_at" TIMESTAMP(3),
ADD COLUMN "converted_by_user_id" UUID,
ADD COLUMN "source_id" UUID,
ADD COLUMN "source_description" TEXT,
ADD COLUMN "estimated_amount" DOUBLE PRECISION,
ADD COLUMN "currency_code" TEXT,
ADD COLUMN "address_line_1" TEXT,
ADD COLUMN "address_line_2" TEXT,
ADD COLUMN "city" TEXT,
ADD COLUMN "state_or_province" TEXT,
ADD COLUMN "postal_code" TEXT,
ADD COLUMN "country_code" TEXT,
ADD COLUMN "utm_source" TEXT,
ADD COLUMN "utm_medium" TEXT,
ADD COLUMN "utm_campaign" TEXT,
ADD COLUMN "utm_content" TEXT,
ADD COLUMN "utm_term" TEXT,
ADD COLUMN "origin_system" TEXT,
ADD COLUMN "origin_external_id" TEXT,
ADD COLUMN "origin_version" TEXT,
ADD COLUMN "archived_at" TIMESTAMP(3),
ADD COLUMN "archived_by_user_id" UUID,
ADD COLUMN "deleted_at" TIMESTAMP(3),
ADD COLUMN "deleted_by_user_id" UUID;

CREATE TABLE "crm_lead_communications" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "type" "CrmCommunicationType" NOT NULL,
    "value" TEXT NOT NULL,
    "normalized_value" TEXT NOT NULL,
    "label" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "crm_lead_communications_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "crm_lead_contacts" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "crm_lead_contacts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "crm_sources" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 1,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "crm_sources_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "crm_lead_conversions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "contact_id" UUID,
    "company_id" UUID,
    "deal_id" UUID,
    "converted_by_user_id" UUID NOT NULL,
    "converted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "crm_lead_conversions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "idempotency_records" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "operation" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response" JSONB NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "crm_lead_communications_workspace_id_type_normalized_value_idx" ON "crm_lead_communications"("workspace_id", "type", "normalized_value");
CREATE INDEX "crm_lead_communications_lead_id_type_is_primary_idx" ON "crm_lead_communications"("lead_id", "type", "is_primary");

CREATE UNIQUE INDEX "crm_lead_contacts_lead_id_contact_id_key" ON "crm_lead_contacts"("lead_id", "contact_id");
CREATE INDEX "crm_lead_contacts_workspace_id_contact_id_idx" ON "crm_lead_contacts"("workspace_id", "contact_id");
CREATE INDEX "crm_lead_contacts_lead_id_is_primary_idx" ON "crm_lead_contacts"("lead_id", "is_primary");

CREATE UNIQUE INDEX "crm_sources_workspace_id_code_key" ON "crm_sources"("workspace_id", "code");

CREATE UNIQUE INDEX "crm_lead_conversions_lead_id_key" ON "crm_lead_conversions"("lead_id");
CREATE INDEX "crm_lead_conversions_workspace_id_converted_at_idx" ON "crm_lead_conversions"("workspace_id", "converted_at");

CREATE UNIQUE INDEX "idempotency_records_workspace_id_actor_user_id_operation_idempotency_key_key" ON "idempotency_records"("workspace_id", "actor_user_id", "operation", "idempotency_key");
CREATE INDEX "idempotency_records_expires_at_idx" ON "idempotency_records"("expires_at");
