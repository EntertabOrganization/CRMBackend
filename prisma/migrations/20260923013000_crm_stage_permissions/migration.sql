CREATE TABLE "crm_role_stage_permissions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "stage_id" UUID NOT NULL,
    "can_view" BOOLEAN NOT NULL DEFAULT true,
    "can_enter" BOOLEAN NOT NULL DEFAULT true,
    "can_leave" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_role_stage_permissions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "crm_role_stage_permissions_role_id_stage_id_key" ON "crm_role_stage_permissions"("role_id", "stage_id");
CREATE INDEX "crm_role_stage_permissions_workspace_id_role_id_idx" ON "crm_role_stage_permissions"("workspace_id", "role_id");
CREATE INDEX "crm_role_stage_permissions_workspace_id_stage_id_idx" ON "crm_role_stage_permissions"("workspace_id", "stage_id");
