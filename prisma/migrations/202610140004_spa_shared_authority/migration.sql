-- Shared Files/Calendar/Activities persistence must not commit from stale SPA authority.
DO $$
DECLARE tab text;
BEGIN
  FOREACH tab IN ARRAY ARRAY['spa_entity_types','spa_capabilities','spa_schema_versions','spa_items',
    'spa_item_field_values','spa_item_observers','spa_type_role_policies','spa_stage_permissions','spa_field_permissions','spa_item_relations']
  LOOP
    EXECUTE format('CREATE TRIGGER spa_shared_authority_epoch BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION calendar_booking_source_epoch()', tab);
  END LOOP;
END $$;

CREATE INDEX spa_items_list_page ON spa_items(workspace_id, type_id, created_at DESC, id);
CREATE INDEX spa_items_kanban_page ON spa_items(workspace_id, type_id, pipeline_id, stage_id, updated_at DESC, id);
CREATE INDEX spa_relations_target_lookup ON spa_item_relations(workspace_id, target_type, target_id);
CREATE INDEX spa_file_value_lookup ON spa_item_field_values(workspace_id, value_text) WHERE value_text IS NOT NULL;
CREATE INDEX spa_file_values_json ON spa_item_field_values USING gin(value_json) WHERE value_json IS NOT NULL;
CREATE INDEX file_object_authority_lookup ON drive_file_versions(workspace_id, object_key);

-- Extend the existing Files target guard without weakening its immutable identity, scan or membership checks.
CREATE OR REPLACE FUNCTION file_attachment_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_table TEXT; valid_target BOOLEAN;
BEGIN
 IF TG_OP = 'UPDATE' THEN
  IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'ATTACHMENT_IDENTITY_IMMUTABLE' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF EXISTS(SELECT 1 FROM file_attachments WHERE id=NEW.id) THEN RETURN NEW; END IF;
 target_table := CASE NEW.entity_type
  WHEN 'TASK' THEN 'tasks' WHEN 'TASK_TEMPLATE' THEN 'task_templates' WHEN 'PROJECT' THEN 'projects'
  WHEN 'CALENDAR_EVENT' THEN 'calendar_events' WHEN 'CHAT' THEN 'collaboration_chats'
  WHEN 'LEAD' THEN 'crm_leads' WHEN 'DEAL' THEN 'crm_deals' WHEN 'CONTACT' THEN 'crm_contacts'
  WHEN 'COMPANY' THEN 'crm_companies' WHEN 'ACTIVITY' THEN 'crm_activities' WHEN 'PRODUCT' THEN 'catalog_products'
  WHEN 'SPA_ITEM' THEN 'spa_items' END;
 IF target_table IS NULL THEN RAISE EXCEPTION 'ATTACHMENT_ENTITY_ACCESS_DENIED' USING ERRCODE='23514'; END IF;
 EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I WHERE id=$1 AND workspace_id=$2)',target_table) INTO valid_target USING NEW.entity_id,NEW.workspace_id;
 IF NOT valid_target OR NOT EXISTS(SELECT 1 FROM drive_files f JOIN drive_file_versions v ON v.id=f.current_version_id AND v.file_id=f.id AND v.workspace_id=f.workspace_id
  WHERE f.id=NEW.file_id AND f.workspace_id=NEW.workspace_id AND f.status='ACTIVE' AND v.scan_status='CLEAN' AND v.processed_at IS NOT NULL)
  OR NOT EXISTS(SELECT 1 FROM workspace_memberships m JOIN users u ON u.id=m.user_id
   WHERE m.workspace_id=NEW.workspace_id AND m.user_id=NEW.attached_by_user_id AND m.status='ACTIVE' AND NOT u.is_deleted)
 THEN RAISE EXCEPTION 'ATTACHMENT_CROSS_WORKSPACE' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION calendar_event_binding_tenant_guard() RETURNS trigger AS $$
DECLARE target_table text; valid_target boolean;
BEGIN
  target_table := CASE NEW.entity_type
    WHEN 'LEAD' THEN 'crm_leads' WHEN 'DEAL' THEN 'crm_deals' WHEN 'CONTACT' THEN 'crm_contacts'
    WHEN 'COMPANY' THEN 'crm_companies' WHEN 'ACTIVITY' THEN 'crm_activities'
    WHEN 'TASK' THEN 'tasks' WHEN 'PROJECT' THEN 'projects' WHEN 'SPA_ITEM' THEN 'spa_items' ELSE NULL END;
  IF target_table IS NULL THEN RAISE EXCEPTION 'EVENT_BINDING_INVALID' USING ERRCODE = '23514'; END IF;
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE id = $1 AND workspace_id = $2)', target_table)
    INTO valid_target USING NEW.entity_id, NEW.workspace_id;
  IF NOT valid_target THEN RAISE EXCEPTION 'EVENT_BINDING_INVALID' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION spa_shared_binding_tenant_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.entity_type <> 'SPA_ITEM' THEN RETURN NEW; END IF;
 IF NOT EXISTS(SELECT 1 FROM spa_items WHERE workspace_id=NEW.workspace_id AND id=NEW.entity_id) THEN
  RAISE EXCEPTION 'SPA_SHARED_BINDING_INVALID' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER spa_task_binding_tenant BEFORE INSERT OR UPDATE ON task_crm_bindings FOR EACH ROW EXECUTE FUNCTION spa_shared_binding_tenant_guard();
CREATE TRIGGER spa_activity_binding_tenant BEFORE INSERT OR UPDATE ON crm_activity_bindings FOR EACH ROW EXECUTE FUNCTION spa_shared_binding_tenant_guard();
