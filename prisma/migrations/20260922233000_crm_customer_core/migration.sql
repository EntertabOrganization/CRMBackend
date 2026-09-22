-- CRM customer identity, communications and relationship foundation.

CREATE TYPE "CrmCommunicationType" AS ENUM ('PHONE', 'EMAIL', 'WEB', 'IM');

ALTER TABLE "crm_deals"
ADD COLUMN "company_id" UUID;

CREATE TABLE "crm_contacts" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "responsible_user_id" UUID NOT NULL,
    "address_line_1" TEXT,
    "address_line_2" TEXT,
    "city" TEXT,
    "state_or_province" TEXT,
    "postal_code" TEXT,
    "country_code" TEXT,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "archived_at" TIMESTAMP(3),
    "archived_by_user_id" UUID,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "deleted_at" TIMESTAMP(3),
    "deleted_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "crm_contacts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "crm_companies" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "responsible_user_id" UUID NOT NULL,
    "address_line_1" TEXT,
    "address_line_2" TEXT,
    "city" TEXT,
    "state_or_province" TEXT,
    "postal_code" TEXT,
    "country_code" TEXT,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "archived_at" TIMESTAMP(3),
    "archived_by_user_id" UUID,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "deleted_at" TIMESTAMP(3),
    "deleted_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "crm_companies_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "crm_contact_communications" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "type" "CrmCommunicationType" NOT NULL,
    "value" TEXT NOT NULL,
    "normalized_value" TEXT NOT NULL,
    "label" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "crm_contact_communications_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "crm_company_communications" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "type" "CrmCommunicationType" NOT NULL,
    "value" TEXT NOT NULL,
    "normalized_value" TEXT NOT NULL,
    "label" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "crm_company_communications_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "crm_contact_companies" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "job_title" TEXT,
    "department" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "crm_contact_companies_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "crm_deal_contacts" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "deal_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "role" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "crm_deal_contacts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "crm_contacts_workspace_id_responsible_user_id_idx" ON "crm_contacts"("workspace_id", "responsible_user_id");
CREATE INDEX "crm_contacts_workspace_id_display_name_idx" ON "crm_contacts"("workspace_id", "display_name");

CREATE INDEX "crm_companies_workspace_id_responsible_user_id_idx" ON "crm_companies"("workspace_id", "responsible_user_id");
CREATE INDEX "crm_companies_workspace_id_name_idx" ON "crm_companies"("workspace_id", "name");

CREATE INDEX "crm_contact_communications_workspace_id_type_normalized_value_idx" ON "crm_contact_communications"("workspace_id", "type", "normalized_value");
CREATE INDEX "crm_contact_communications_contact_id_type_is_primary_idx" ON "crm_contact_communications"("contact_id", "type", "is_primary");

CREATE INDEX "crm_company_communications_workspace_id_type_normalized_value_idx" ON "crm_company_communications"("workspace_id", "type", "normalized_value");
CREATE INDEX "crm_company_communications_company_id_type_is_primary_idx" ON "crm_company_communications"("company_id", "type", "is_primary");

CREATE UNIQUE INDEX "crm_contact_companies_contact_id_company_id_key" ON "crm_contact_companies"("contact_id", "company_id");
CREATE INDEX "crm_contact_companies_workspace_id_company_id_idx" ON "crm_contact_companies"("workspace_id", "company_id");
CREATE INDEX "crm_contact_companies_contact_id_is_primary_idx" ON "crm_contact_companies"("contact_id", "is_primary");

CREATE UNIQUE INDEX "crm_deal_contacts_deal_id_contact_id_key" ON "crm_deal_contacts"("deal_id", "contact_id");
CREATE INDEX "crm_deal_contacts_workspace_id_contact_id_idx" ON "crm_deal_contacts"("workspace_id", "contact_id");
CREATE INDEX "crm_deal_contacts_deal_id_is_primary_idx" ON "crm_deal_contacts"("deal_id", "is_primary");
