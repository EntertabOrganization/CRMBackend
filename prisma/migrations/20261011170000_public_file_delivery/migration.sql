ALTER TABLE file_delivery_grants ADD COLUMN public_link_id UUID, ADD COLUMN public_link_version INTEGER;
ALTER TABLE file_delivery_grants ADD CONSTRAINT file_delivery_public_pair CHECK((public_link_id IS NULL) = (public_link_version IS NULL) AND (public_link_version IS NULL OR public_link_version > 0));
CREATE INDEX file_delivery_public_consumed ON file_delivery_grants(public_link_id) WHERE consumed_at IS NOT NULL;
ALTER TABLE file_public_links ADD CONSTRAINT file_public_download_limit CHECK(max_downloads IS NULL OR download_count <= max_downloads);
CREATE FUNCTION file_delivery_public_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'INSERT' AND NEW.public_link_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM file_delivery_grants WHERE id = NEW.id) AND NOT EXISTS(
  SELECT 1 FROM file_public_links l JOIN drive_files f ON f.id = NEW.file_id AND f.workspace_id = NEW.workspace_id
  WHERE l.id = NEW.public_link_id AND l.workspace_id = NEW.workspace_id AND l.version = NEW.public_link_version
   AND l.created_by_user_id = NEW.user_id AND l.is_active AND l.revoked_at IS NULL AND l.permission_mode = 'DOWNLOAD'
   AND l.expires_at >= NEW.expires_at AND l.download_count < COALESCE(l.max_downloads, 2147483647)
   AND (l.resource_type = 'FILE' AND l.resource_id = f.id OR l.resource_type = 'FOLDER' AND l.resource_id = f.folder_id OR
    l.resource_type = 'FOLDER' AND l.include_children AND EXISTS(WITH RECURSIVE ancestors AS (
     SELECT id, parent_folder_id FROM file_folders WHERE id = f.folder_id AND workspace_id = NEW.workspace_id
     UNION ALL SELECT p.id, p.parent_folder_id FROM file_folders p JOIN ancestors a ON p.id = a.parent_folder_id WHERE p.workspace_id = NEW.workspace_id
    ) SELECT 1 FROM ancestors WHERE id = l.resource_id))) THEN
   RAISE EXCEPTION 'FILE_DELIVERY_UNAVAILABLE' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER file_delivery_public_identity_guard BEFORE INSERT OR UPDATE ON file_delivery_grants FOR EACH ROW EXECUTE FUNCTION file_delivery_public_identity_guard();
CREATE FUNCTION file_delivery_public_accounting_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE link_id UUID; actual BIGINT; recorded INTEGER;
BEGIN
 IF TG_TABLE_NAME = 'file_public_links' THEN link_id := NEW.id; ELSE link_id := NEW.public_link_id; END IF;
 IF link_id IS NULL THEN RETURN NULL; END IF;
 SELECT download_count INTO recorded FROM file_public_links WHERE id = link_id;
 IF NOT FOUND THEN RETURN NULL; END IF; -- Purge retains delivery proofs after revoking/deleting the capability.
 SELECT count(*) INTO actual FROM file_delivery_grants WHERE public_link_id = link_id AND consumed_at IS NOT NULL;
 IF actual > recorded THEN RAISE EXCEPTION 'PUBLIC_LINK_DOWNLOAD_LIMIT' USING ERRCODE = '23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER file_delivery_public_accounting_guard AFTER INSERT OR UPDATE ON file_delivery_grants DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION file_delivery_public_accounting_guard();
CREATE CONSTRAINT TRIGGER file_delivery_public_accounting_guard AFTER INSERT OR UPDATE ON file_public_links DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION file_delivery_public_accounting_guard();
