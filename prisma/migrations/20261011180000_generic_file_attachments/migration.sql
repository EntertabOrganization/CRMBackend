CREATE TABLE file_attachments (
 id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES workspaces(id), file_id UUID NOT NULL,
 entity_type TEXT NOT NULL, entity_id UUID NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('ATTACHMENT','RESULT','COVER','DOCUMENT','MEDIA','OTHER')),
 attached_by_user_id UUID NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL,
 FOREIGN KEY(workspace_id,file_id) REFERENCES drive_files(workspace_id,id) DEFERRABLE INITIALLY DEFERRED,
 UNIQUE(workspace_id,file_id,entity_type,entity_id,role)
);
CREATE INDEX file_attachments_entity ON file_attachments(workspace_id,entity_type,entity_id);
CREATE FUNCTION file_attachment_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
  WHEN 'COMPANY' THEN 'crm_companies' WHEN 'ACTIVITY' THEN 'crm_activities' WHEN 'PRODUCT' THEN 'catalog_products' END;
 IF target_table IS NULL THEN RAISE EXCEPTION 'ATTACHMENT_ENTITY_ACCESS_DENIED' USING ERRCODE='23514'; END IF;
 EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I WHERE id=$1 AND workspace_id=$2)',target_table) INTO valid_target USING NEW.entity_id,NEW.workspace_id;
 IF NOT valid_target OR NOT EXISTS(SELECT 1 FROM drive_files f JOIN drive_file_versions v ON v.id=f.current_version_id AND v.file_id=f.id AND v.workspace_id=f.workspace_id
  WHERE f.id=NEW.file_id AND f.workspace_id=NEW.workspace_id AND f.status='ACTIVE' AND v.scan_status='CLEAN' AND v.processed_at IS NOT NULL)
  OR NOT EXISTS(SELECT 1 FROM workspace_memberships m JOIN users u ON u.id=m.user_id
   WHERE m.workspace_id=NEW.workspace_id AND m.user_id=NEW.attached_by_user_id AND m.status='ACTIVE' AND NOT u.is_deleted)
 THEN RAISE EXCEPTION 'ATTACHMENT_CROSS_WORKSPACE' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER file_attachment_identity_guard BEFORE INSERT OR UPDATE ON file_attachments FOR EACH ROW EXECUTE FUNCTION file_attachment_identity_guard();
CREATE TRIGGER file_attachment_revision BEFORE INSERT OR UPDATE OR DELETE ON file_attachments FOR EACH ROW EXECUTE FUNCTION calendar_booking_source_epoch();
-- Remote owning-record, field and communication changes must fence delivery and attach commits.
DO $$ DECLARE tab TEXT; BEGIN
 FOREACH tab IN ARRAY ARRAY['crm_leads','crm_deals','crm_contacts','crm_companies','crm_record_observers','crm_activities',
  'crm_activity_bindings','crm_activity_participants','crm_timeline_comments','crm_custom_field_values','crm_custom_fields',
  'catalog_products','catalog_product_media','collaboration_chats','collaboration_chat_members','collaboration_chat_membership_sources',
  'collab_spaces','collab_space_members','calendar_event_attendees'] LOOP
  EXECUTE format('CREATE TRIGGER file_attachment_authority BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION calendar_booking_source_epoch()',tab);
 END LOOP;
END $$;
