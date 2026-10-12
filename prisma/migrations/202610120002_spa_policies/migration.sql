-- CreateTable
CREATE TABLE "spa_type_role_policies" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "type_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "scope" TEXT NOT NULL,

    CONSTRAINT "spa_type_role_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spa_stage_permissions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "type_id" UUID NOT NULL,
    "pipeline_id" UUID NOT NULL,
    "stage_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "scope" TEXT NOT NULL,

    CONSTRAINT "spa_stage_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spa_field_permissions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "type_id" UUID NOT NULL,
    "field_id" UUID NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "can_view" BOOLEAN NOT NULL,
    "can_edit" BOOLEAN NOT NULL,

    CONSTRAINT "spa_field_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spa_policy_versions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "type_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "spa_policy_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "spa_type_role_policies_workspace_id_type_id_role_id_action_key" ON "spa_type_role_policies"("workspace_id", "type_id", "role_id", "action");

-- CreateIndex
CREATE UNIQUE INDEX "spa_stage_permissions_workspace_id_type_id_stage_id_role_id_key" ON "spa_stage_permissions"("workspace_id", "type_id", "stage_id", "role_id", "action");

-- CreateIndex
CREATE UNIQUE INDEX "spa_field_permissions_workspace_id_type_id_field_id_subject_key" ON "spa_field_permissions"("workspace_id", "type_id", "field_id", "subject_type", "subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "spa_policy_versions_workspace_id_type_id_key" ON "spa_policy_versions"("workspace_id", "type_id");

-- Tenant identities are checked by composite foreign keys even for valid foreign UUIDs.
CREATE UNIQUE INDEX IF NOT EXISTS "roles_workspace_id_id_spa_fk" ON "roles"("workspace_id", "id");
CREATE UNIQUE INDEX "spa_fields_workspace_type_id_fk" ON "spa_field_definitions"("workspace_id", "type_id", "id");
CREATE UNIQUE INDEX "spa_pipelines_workspace_type_id_fk" ON "spa_pipelines"("workspace_id", "type_id", "id");
ALTER TABLE "spa_type_role_policies"
  ADD CONSTRAINT "spa_type_policy_type_fk" FOREIGN KEY ("workspace_id", "type_id") REFERENCES "spa_entity_types"("workspace_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "spa_type_policy_role_fk" FOREIGN KEY ("workspace_id", "role_id") REFERENCES "roles"("workspace_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "spa_type_policy_scope_check" CHECK (scope IN ('NONE','OWN','DEPARTMENT','DEPARTMENT_TREE','TEAM','ALL'));
ALTER TABLE "spa_stage_permissions"
  ADD CONSTRAINT "spa_stage_policy_pipeline_fk" FOREIGN KEY ("workspace_id", "type_id", "pipeline_id") REFERENCES "spa_pipelines"("workspace_id", "type_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "spa_stage_policy_stage_fk" FOREIGN KEY ("workspace_id", "pipeline_id", "stage_id") REFERENCES "spa_stages"("workspace_id", "pipeline_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "spa_stage_policy_role_fk" FOREIGN KEY ("workspace_id", "role_id") REFERENCES "roles"("workspace_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "spa_stage_policy_scope_check" CHECK (scope IN ('NONE','OWN','DEPARTMENT','DEPARTMENT_TREE','TEAM','ALL'));
ALTER TABLE "spa_field_permissions"
  ADD CONSTRAINT "spa_field_policy_field_fk" FOREIGN KEY ("workspace_id", "type_id", "field_id") REFERENCES "spa_field_definitions"("workspace_id", "type_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "spa_field_policy_subject_check" CHECK ("subject_type" IN ('ROLE','USER') AND (NOT "can_edit" OR "can_view"));
ALTER TABLE "spa_policy_versions"
  ADD CONSTRAINT "spa_policy_version_type_fk" FOREIGN KEY ("workspace_id", "type_id") REFERENCES "spa_entity_types"("workspace_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "spa_policy_version_positive" CHECK (version > 0);
ALTER TABLE "spa_items" ADD CONSTRAINT "spa_item_pipeline_type_fk" FOREIGN KEY ("workspace_id", "type_id", "pipeline_id") REFERENCES "spa_pipelines"("workspace_id", "type_id", "id") ON DELETE RESTRICT;

CREATE FUNCTION spa_validate_policy_subject() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.subject_type = 'ROLE' THEN
    IF NOT EXISTS (SELECT 1 FROM roles WHERE workspace_id=NEW.workspace_id AND id=NEW.subject_id AND NOT is_deleted) THEN
      RAISE EXCEPTION 'SPA_POLICY_SUBJECT_INVALID' USING ERRCODE='23503';
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM workspace_memberships WHERE workspace_id=NEW.workspace_id AND user_id=NEW.subject_id AND NOT is_deleted) THEN
      RAISE EXCEPTION 'SPA_POLICY_SUBJECT_INVALID' USING ERRCODE='23503';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER spa_policy_subject_tenant BEFORE INSERT OR UPDATE ON spa_field_permissions FOR EACH ROW EXECUTE FUNCTION spa_validate_policy_subject();
