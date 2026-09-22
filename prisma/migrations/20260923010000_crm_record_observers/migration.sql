CREATE TYPE "CrmRecordEntityType" AS ENUM ('LEAD', 'DEAL', 'CONTACT', 'COMPANY');

CREATE TABLE "crm_record_observers" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "entity_type" "CrmRecordEntityType" NOT NULL,
    "record_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_record_observers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "crm_record_observers_workspace_id_entity_type_record_id_user_id_key" ON "crm_record_observers"("workspace_id", "entity_type", "record_id", "user_id");
CREATE INDEX "crm_record_observers_workspace_id_user_id_idx" ON "crm_record_observers"("workspace_id", "user_id");
CREATE INDEX "crm_record_observers_workspace_id_entity_type_record_id_idx" ON "crm_record_observers"("workspace_id", "entity_type", "record_id");
