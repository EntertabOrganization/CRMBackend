-- CreateTable
CREATE TABLE "spa_item_relations" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "type_id" UUID NOT NULL,
    "source_item_id" UUID NOT NULL,
    "relation_definition_id" UUID NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" UUID NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spa_item_relations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spa_user_view_preferences" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "type_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "view_type" TEXT NOT NULL,
    "preferences" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "spa_user_view_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "spa_item_relations_workspace_id_target_type_target_id_idx" ON "spa_item_relations"("workspace_id", "target_type", "target_id");

-- CreateIndex
CREATE UNIQUE INDEX "spa_item_relations_workspace_id_id_key" ON "spa_item_relations"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "spa_item_relations_workspace_id_source_item_id_relation_def_key" ON "spa_item_relations"("workspace_id", "source_item_id", "relation_definition_id", "target_type", "target_id");

-- CreateIndex
CREATE UNIQUE INDEX "spa_user_view_preferences_workspace_id_type_id_user_id_view_key" ON "spa_user_view_preferences"("workspace_id", "type_id", "user_id", "view_type");

CREATE UNIQUE INDEX "spa_items_workspace_type_id_relation_fk" ON spa_items(workspace_id,type_id,id);
ALTER TABLE spa_item_relations
  ADD CONSTRAINT spa_relation_source_fk FOREIGN KEY (workspace_id,type_id,source_item_id) REFERENCES spa_items(workspace_id,type_id,id) ON DELETE CASCADE;
ALTER TABLE spa_user_view_preferences
  ADD CONSTRAINT spa_view_type_fk FOREIGN KEY (workspace_id,type_id) REFERENCES spa_entity_types(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT spa_view_user_fk FOREIGN KEY (workspace_id,user_id) REFERENCES workspace_memberships(workspace_id,user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT spa_view_valid CHECK (view_type IN ('LIST','KANBAN') AND version > 0);
CREATE UNIQUE INDEX spa_relation_primary_unique ON spa_item_relations(workspace_id,source_item_id,relation_definition_id) WHERE is_primary;

CREATE FUNCTION spa_validate_relation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE definition jsonb; target_valid boolean := false;
BEGIN
  -- Definitions come from the current immutable publication; arbitrary definition UUIDs are invalid.
  SELECT d INTO definition FROM spa_entity_types t JOIN spa_schema_versions v
    ON v.workspace_id=t.workspace_id AND v.type_id=t.id AND v.version_number=t.schema_version,
    LATERAL jsonb_array_elements(v.snapshot->'relations') d
    WHERE t.workspace_id=NEW.workspace_id AND t.id=NEW.type_id AND d->>'id'=NEW.relation_definition_id::text;
  IF definition IS NULL OR definition->>'targetType' <> NEW.target_type THEN
    RAISE EXCEPTION 'SPA_RELATION_TARGET_INVALID' USING ERRCODE='23503';
  END IF;
  -- Also fence cardinality for direct SQL writers, independent from API advisory locks.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.workspace_id::text || ':relation:' || NEW.source_item_id::text || ':' || NEW.relation_definition_id::text, 0));
  IF definition->>'cardinality'='ONE' AND EXISTS (SELECT 1 FROM spa_item_relations r
    WHERE r.workspace_id=NEW.workspace_id AND r.source_item_id=NEW.source_item_id
    AND r.relation_definition_id=NEW.relation_definition_id AND r.id<>NEW.id) THEN
    RAISE EXCEPTION 'SPA_RELATION_CARDINALITY' USING ERRCODE='23505';
  END IF;
  CASE NEW.target_type
    WHEN 'SPA_ITEM' THEN SELECT EXISTS (SELECT 1 FROM spa_items WHERE workspace_id=NEW.workspace_id AND id=NEW.target_id AND status<>'TRASHED'
      AND (definition->>'targetSubtypeId' IS NULL OR type_id::text=definition->>'targetSubtypeId')) INTO target_valid;
    WHEN 'CONTACT' THEN SELECT EXISTS (SELECT 1 FROM crm_contacts WHERE workspace_id=NEW.workspace_id AND id=NEW.target_id AND NOT is_deleted) INTO target_valid;
    WHEN 'COMPANY' THEN SELECT EXISTS (SELECT 1 FROM crm_companies WHERE workspace_id=NEW.workspace_id AND id=NEW.target_id AND NOT is_deleted) INTO target_valid;
    WHEN 'LEAD' THEN SELECT EXISTS (SELECT 1 FROM crm_leads WHERE workspace_id=NEW.workspace_id AND id=NEW.target_id AND NOT is_deleted) INTO target_valid;
    WHEN 'DEAL' THEN SELECT EXISTS (SELECT 1 FROM crm_deals WHERE workspace_id=NEW.workspace_id AND id=NEW.target_id AND NOT is_deleted) INTO target_valid;
    WHEN 'TASK' THEN SELECT EXISTS (SELECT 1 FROM tasks WHERE workspace_id=NEW.workspace_id AND id=NEW.target_id AND NOT is_deleted) INTO target_valid;
    WHEN 'PROJECT' THEN SELECT EXISTS (SELECT 1 FROM projects WHERE workspace_id=NEW.workspace_id AND id=NEW.target_id AND NOT is_deleted) INTO target_valid;
    WHEN 'EVENT' THEN SELECT EXISTS (SELECT 1 FROM calendar_events WHERE workspace_id=NEW.workspace_id AND id=NEW.target_id AND NOT is_deleted) INTO target_valid;
    WHEN 'FILE' THEN SELECT EXISTS (SELECT 1 FROM drive_files WHERE workspace_id=NEW.workspace_id AND id=NEW.target_id AND status='ACTIVE') INTO target_valid;
    WHEN 'PRODUCT' THEN SELECT EXISTS (SELECT 1 FROM catalog_products WHERE workspace_id=NEW.workspace_id AND id=NEW.target_id) INTO target_valid;
    WHEN 'ACTIVITY' THEN SELECT EXISTS (SELECT 1 FROM crm_activities WHERE workspace_id=NEW.workspace_id AND id=NEW.target_id AND NOT is_deleted) INTO target_valid;
    WHEN 'DOCUMENT' THEN SELECT EXISTS (SELECT 1 FROM generated_documents WHERE workspace_id=NEW.workspace_id AND id=NEW.target_id) INTO target_valid;
    ELSE target_valid := false;
  END CASE;
  IF NOT target_valid THEN RAISE EXCEPTION 'SPA_RELATION_TARGET_INVALID' USING ERRCODE='23503'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER spa_relation_tenant BEFORE INSERT OR UPDATE ON spa_item_relations FOR EACH ROW EXECUTE FUNCTION spa_validate_relation();
