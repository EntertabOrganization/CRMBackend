-- CreateTable
CREATE TABLE "spa_entity_types" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "plural_name" TEXT NOT NULL,
    "description" TEXT,
    "placement" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "schema_version" INTEGER NOT NULL DEFAULT 0,
    "created_by_user_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "spa_entity_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spa_capabilities" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "type_id" UUID NOT NULL,
    "capability_key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "configuration" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "spa_capabilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spa_schema_drafts" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "type_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "snapshot" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "spa_schema_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spa_schema_versions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "type_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "checksum" TEXT NOT NULL,
    "published_by" UUID NOT NULL,
    "published_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spa_schema_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spa_field_definitions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "type_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "field_type" TEXT NOT NULL,
    "is_required" BOOLEAN NOT NULL DEFAULT false,
    "is_multiple" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_searchable" BOOLEAN NOT NULL DEFAULT false,
    "default_json" JSONB,
    "validation" JSONB NOT NULL DEFAULT '{}',
    "visibility" JSONB NOT NULL DEFAULT '{}',
    "options" JSONB NOT NULL DEFAULT '[]',
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "spa_field_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spa_pipelines" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "type_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "spa_pipelines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spa_stages" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "pipeline_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "semantic" TEXT NOT NULL DEFAULT 'PROGRESS',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "requirements" JSONB NOT NULL DEFAULT '[]',
    "transition_rules" JSONB NOT NULL DEFAULT '[]',
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "spa_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spa_items" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "type_id" UUID NOT NULL,
    "item_number" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "assigned_user_id" UUID NOT NULL,
    "company_id" UUID,
    "pipeline_id" UUID,
    "stage_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "schema_version" INTEGER NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "updated_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "trashed_at" TIMESTAMPTZ(6),
    "purge_after" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    "legal_hold" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "spa_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spa_item_field_values" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "field_id" UUID NOT NULL,
    "value_text" TEXT,
    "value_number" DECIMAL(24,6),
    "value_date" TIMESTAMPTZ(6),
    "value_boolean" BOOLEAN,
    "value_json" JSONB,
    "schema_version" INTEGER NOT NULL,

    CONSTRAINT "spa_item_field_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spa_item_observers" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,

    CONSTRAINT "spa_item_observers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spa_history" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "type_id" UUID NOT NULL,
    "item_id" UUID,
    "actor_user_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "changes" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spa_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spa_numbering_schemes" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "type_id" UUID NOT NULL,
    "prefix_template" TEXT NOT NULL,
    "padding" INTEGER NOT NULL DEFAULT 6,
    "reset_policy" TEXT NOT NULL DEFAULT 'NEVER',
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "spa_numbering_schemes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spa_numbering_sequences" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "type_id" UUID NOT NULL,
    "period_key" TEXT NOT NULL,
    "next_value" BIGINT NOT NULL DEFAULT 1,

    CONSTRAINT "spa_numbering_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "spa_entity_types_workspace_id_status_placement_idx" ON "spa_entity_types"("workspace_id", "status", "placement");

-- CreateIndex
CREATE UNIQUE INDEX "spa_entity_types_workspace_id_id_key" ON "spa_entity_types"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "spa_entity_types_workspace_id_code_key" ON "spa_entity_types"("workspace_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "spa_capabilities_workspace_id_type_id_capability_key_key" ON "spa_capabilities"("workspace_id", "type_id", "capability_key");

-- CreateIndex
CREATE UNIQUE INDEX "spa_schema_drafts_workspace_id_type_id_key" ON "spa_schema_drafts"("workspace_id", "type_id");

-- CreateIndex
CREATE UNIQUE INDEX "spa_schema_drafts_workspace_id_id_key" ON "spa_schema_drafts"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "spa_schema_versions_workspace_id_type_id_version_number_key" ON "spa_schema_versions"("workspace_id", "type_id", "version_number");

-- CreateIndex
CREATE UNIQUE INDEX "spa_schema_versions_workspace_id_id_key" ON "spa_schema_versions"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "spa_field_definitions_workspace_id_id_key" ON "spa_field_definitions"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "spa_field_definitions_workspace_id_type_id_code_key" ON "spa_field_definitions"("workspace_id", "type_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "spa_pipelines_workspace_id_id_key" ON "spa_pipelines"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "spa_pipelines_workspace_id_type_id_code_key" ON "spa_pipelines"("workspace_id", "type_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "spa_stages_workspace_id_id_key" ON "spa_stages"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "spa_stages_workspace_id_pipeline_id_code_key" ON "spa_stages"("workspace_id", "pipeline_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "spa_stages_workspace_id_pipeline_id_id_key" ON "spa_stages"("workspace_id", "pipeline_id", "id");

-- CreateIndex
CREATE INDEX "spa_items_workspace_id_type_id_status_assigned_user_id_idx" ON "spa_items"("workspace_id", "type_id", "status", "assigned_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "spa_items_workspace_id_id_key" ON "spa_items"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "spa_items_workspace_id_type_id_item_number_key" ON "spa_items"("workspace_id", "type_id", "item_number");

-- CreateIndex
CREATE UNIQUE INDEX "spa_item_field_values_workspace_id_item_id_field_id_key" ON "spa_item_field_values"("workspace_id", "item_id", "field_id");

-- CreateIndex
CREATE UNIQUE INDEX "spa_item_observers_workspace_id_item_id_user_id_key" ON "spa_item_observers"("workspace_id", "item_id", "user_id");

-- CreateIndex
CREATE INDEX "spa_history_workspace_id_type_id_item_id_occurred_at_idx" ON "spa_history"("workspace_id", "type_id", "item_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "spa_numbering_schemes_workspace_id_type_id_key" ON "spa_numbering_schemes"("workspace_id", "type_id");

-- CreateIndex
CREATE UNIQUE INDEX "spa_numbering_sequences_workspace_id_type_id_period_key_key" ON "spa_numbering_sequences"("workspace_id", "type_id", "period_key");

-- Workspace-consistent relationships are enforced independently of application filters.
ALTER TABLE spa_entity_types ADD CONSTRAINT spa_types_workspace_fk FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT;
ALTER TABLE spa_entity_types ADD CONSTRAINT spa_types_creator_fk FOREIGN KEY (workspace_id, created_by_user_id) REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE RESTRICT;
ALTER TABLE spa_entity_types ADD CONSTRAINT spa_types_valid CHECK (code ~ '^[A-Z][A-Z0-9_]{1,63}$' AND placement IN ('CRM','AUTOMATION') AND status IN ('DRAFT','ACTIVE','ARCHIVED','DELETION_PENDING') AND version > 0 AND schema_version >= 0);

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['spa_capabilities','spa_schema_drafts','spa_schema_versions','spa_field_definitions','spa_pipelines','spa_items','spa_history','spa_numbering_schemes','spa_numbering_sequences'] LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (workspace_id,type_id) REFERENCES spa_entity_types(workspace_id,id) ON DELETE RESTRICT', table_name, table_name || '_type_fk');
  END LOOP;
END $$;
ALTER TABLE spa_stages ADD CONSTRAINT spa_stage_pipeline_fk FOREIGN KEY (workspace_id,pipeline_id) REFERENCES spa_pipelines(workspace_id,id) ON DELETE RESTRICT;
ALTER TABLE spa_items ADD CONSTRAINT spa_item_pipeline_fk FOREIGN KEY (workspace_id,pipeline_id) REFERENCES spa_pipelines(workspace_id,id) ON DELETE RESTRICT;
ALTER TABLE spa_items ADD CONSTRAINT spa_item_stage_fk FOREIGN KEY (workspace_id,pipeline_id,stage_id) REFERENCES spa_stages(workspace_id,pipeline_id,id) ON DELETE RESTRICT;
ALTER TABLE spa_items ADD CONSTRAINT spa_item_assignment_fk FOREIGN KEY (workspace_id,assigned_user_id) REFERENCES workspace_memberships(workspace_id,user_id) ON DELETE RESTRICT;
ALTER TABLE spa_items ADD CONSTRAINT spa_item_valid CHECK (status IN ('ACTIVE','COMPLETED','TRASHED') AND version > 0 AND schema_version > 0 AND ((pipeline_id IS NULL) = (stage_id IS NULL)));
ALTER TABLE spa_item_field_values ADD CONSTRAINT spa_value_item_fk FOREIGN KEY (workspace_id,item_id) REFERENCES spa_items(workspace_id,id) ON DELETE CASCADE;
ALTER TABLE spa_item_field_values ADD CONSTRAINT spa_value_field_fk FOREIGN KEY (workspace_id,field_id) REFERENCES spa_field_definitions(workspace_id,id) ON DELETE RESTRICT;
ALTER TABLE spa_item_observers ADD CONSTRAINT spa_observer_item_fk FOREIGN KEY (workspace_id,item_id) REFERENCES spa_items(workspace_id,id) ON DELETE CASCADE;
ALTER TABLE spa_item_observers ADD CONSTRAINT spa_observer_user_fk FOREIGN KEY (workspace_id,user_id) REFERENCES workspace_memberships(workspace_id,user_id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX spa_pipeline_one_default ON spa_pipelines(workspace_id,type_id) WHERE is_default AND status = 'ACTIVE';
CREATE UNIQUE INDEX spa_stage_one_default ON spa_stages(workspace_id,pipeline_id) WHERE is_default AND status = 'ACTIVE';
ALTER TABLE spa_numbering_sequences ADD CONSTRAINT spa_sequence_positive CHECK (next_value > 0);

-- Published snapshots and immutable domain history cannot be changed by ordinary SQL/API access.
CREATE FUNCTION spa_reject_history_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'SPA_HISTORY_IMMUTABLE'; END $$;
CREATE TRIGGER spa_schema_immutable BEFORE UPDATE OR DELETE ON spa_schema_versions FOR EACH ROW EXECUTE FUNCTION spa_reject_history_change();
CREATE TRIGGER spa_history_immutable BEFORE UPDATE OR DELETE ON spa_history FOR EACH ROW EXECUTE FUNCTION spa_reject_history_change();
