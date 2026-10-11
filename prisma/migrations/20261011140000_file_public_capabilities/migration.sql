ALTER TABLE file_public_links DROP CONSTRAINT file_public_links_resource_type_check;
ALTER TABLE file_public_links ADD CONSTRAINT file_public_links_resource_type_check CHECK(resource_type IN ('FILE','FOLDER'));
ALTER TABLE file_public_links ADD CONSTRAINT file_public_links_file_children_check CHECK(resource_type <> 'FILE' OR NOT include_children);
DO $$ DECLARE item RECORD; BEGIN
 FOR item IN SELECT conname FROM pg_constraint WHERE conrelid = 'file_public_links'::regclass AND contype = 'f'
   AND confrelid = 'file_folders'::regclass LOOP
   EXECUTE format('ALTER TABLE file_public_links DROP CONSTRAINT %I', item.conname);
 END LOOP;
END $$;
CREATE FUNCTION file_public_link_parent_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE live file_public_links%ROWTYPE;
BEGIN
 SELECT * INTO live FROM file_public_links WHERE id = NEW.id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF live.resource_type = 'FILE' THEN
   IF NOT EXISTS(SELECT 1 FROM drive_files WHERE id = live.resource_id AND workspace_id = live.workspace_id) THEN
     RAISE EXCEPTION 'PUBLIC_LINK_NOT_FOUND' USING ERRCODE = '23514';
   END IF;
 ELSIF NOT EXISTS(SELECT 1 FROM file_folders WHERE id = live.resource_id AND workspace_id = live.workspace_id) THEN
   RAISE EXCEPTION 'PUBLIC_LINK_NOT_FOUND' USING ERRCODE = '23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER file_public_link_parent_guard AFTER INSERT OR UPDATE ON file_public_links
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION file_public_link_parent_guard();
CREATE FUNCTION file_public_link_parent_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM file_public_links WHERE workspace_id = OLD.workspace_id AND resource_id = OLD.id AND
   resource_type = CASE WHEN TG_TABLE_NAME = 'drive_files' THEN 'FILE' ELSE 'FOLDER' END) THEN
   RAISE EXCEPTION 'PUBLIC_LINK_NOT_FOUND' USING ERRCODE = '23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER file_public_link_file_delete_guard AFTER DELETE ON drive_files
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION file_public_link_parent_delete_guard();
CREATE CONSTRAINT TRIGGER file_public_link_folder_delete_guard AFTER DELETE ON file_folders
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION file_public_link_parent_delete_guard();
-- Binding checks on anonymous metadata participate in the same authoritative Workspace revision as ACLs and links.
CREATE TRIGGER file_public_binding_revision BEFORE INSERT OR UPDATE OR DELETE ON calendar_event_files
 FOR EACH ROW EXECUTE FUNCTION calendar_booking_source_epoch();
CREATE TRIGGER file_public_binding_revision BEFORE INSERT OR UPDATE OR DELETE ON task_results
 FOR EACH ROW EXECUTE FUNCTION calendar_booking_source_epoch();
CREATE TRIGGER file_public_binding_revision BEFORE INSERT OR UPDATE OR DELETE ON task_templates
 FOR EACH ROW EXECUTE FUNCTION calendar_booking_source_epoch();
