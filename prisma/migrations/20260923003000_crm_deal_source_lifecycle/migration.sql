ALTER TABLE "crm_deals"
ADD COLUMN "source_id" UUID,
ADD COLUMN "source_description" TEXT,
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

CREATE INDEX "crm_deals_workspace_id_source_id_idx" ON "crm_deals"("workspace_id", "source_id");
