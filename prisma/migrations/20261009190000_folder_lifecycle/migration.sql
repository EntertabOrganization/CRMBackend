ALTER TABLE file_folders ADD COLUMN public_share_version INTEGER NOT NULL DEFAULT 1 CHECK(public_share_version > 0);

-- Share revocation is monotonic; restoring a tree never revives earlier capabilities.
CREATE FUNCTION file_folder_share_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.public_share_version < OLD.public_share_version THEN
    RAISE EXCEPTION 'RESOURCE_VERSION_CONFLICT' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER file_folder_share_guard BEFORE UPDATE ON file_folders FOR EACH ROW EXECUTE FUNCTION file_folder_share_guard();

DO $$ DECLARE source TEXT; BEGIN
  FOREACH source IN ARRAY ARRAY['file_storages', 'file_folders', 'file_permission_assignments', 'storage_access_sources'] LOOP
    EXECUTE format('CREATE TRIGGER file_source_revision BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION calendar_booking_source_epoch()', source);
  END LOOP;
END $$;
CREATE FUNCTION file_retention_source_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE scope UUID;
BEGIN
  IF COALESCE(to_jsonb(NEW)->>'collection', to_jsonb(OLD)->>'collection') = 'retentionRecords' THEN
    scope := COALESCE((to_jsonb(NEW)->>'workspace_id')::uuid, (to_jsonb(OLD)->>'workspace_id')::uuid);
    PERFORM calendar_booking_lock_workspace(scope);
    UPDATE calendar_availability_epochs SET epoch = epoch + 1 WHERE workspace_id = scope;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER file_retention_source_revision BEFORE INSERT OR UPDATE OR DELETE ON commercial_pack_records FOR EACH ROW EXECUTE FUNCTION file_retention_source_revision();

CREATE FUNCTION file_folder_retention_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ids UUID[];
BEGIN
  PERFORM calendar_booking_lock_workspace(OLD.workspace_id);
  WITH RECURSIVE ancestors AS (
    SELECT id, parent_folder_id, purge_after FROM file_folders WHERE id = OLD.id AND workspace_id = OLD.workspace_id
    UNION ALL SELECT f.id, f.parent_folder_id, f.purge_after FROM file_folders f JOIN ancestors a ON f.id = a.parent_folder_id
      WHERE f.workspace_id = OLD.workspace_id AND f.storage_id = OLD.storage_id
  ) SELECT array_agg(id) INTO ids FROM ancestors;
  IF OLD.purge_after > CURRENT_TIMESTAMP OR EXISTS(SELECT 1 FROM file_folders WHERE id = ANY(ids) AND purge_after > CURRENT_TIMESTAMP) OR
    EXISTS(SELECT 1 FROM commercial_pack_records WHERE workspace_id = OLD.workspace_id AND collection = 'retentionRecords' AND
      (data->>'resourceId')::uuid = ANY(array_append(ids, OLD.storage_id)) AND data->>'purgedAt' IS NULL AND
      (data->>'legalHold' = 'true' OR (data->>'expiresAt')::timestamptz > CURRENT_TIMESTAMP)) THEN
    RAISE EXCEPTION 'FILE_RETENTION_HOLD' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER file_folder_retention_guard BEFORE DELETE ON file_folders FOR EACH ROW EXECUTE FUNCTION file_folder_retention_guard();
