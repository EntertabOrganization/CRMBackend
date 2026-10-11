CREATE TABLE file_public_links (
  id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  resource_type TEXT NOT NULL CHECK(resource_type = 'FOLDER'), resource_id UUID NOT NULL,
  token_hash TEXT NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
  permission_mode TEXT NOT NULL CHECK(permission_mode IN ('VIEW','DOWNLOAD')), password_hash TEXT,
  expires_at TIMESTAMPTZ NOT NULL, max_downloads INTEGER CHECK(max_downloads > 0),
  download_count INTEGER NOT NULL DEFAULT 0 CHECK(download_count >= 0), access_count INTEGER NOT NULL DEFAULT 0 CHECK(access_count >= 0),
  include_children BOOLEAN NOT NULL, is_active BOOLEAN NOT NULL,
  created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, revoked_at TIMESTAMPTZ,
  resource_share_version INTEGER NOT NULL CHECK(resource_share_version > 0), version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY(workspace_id, resource_id) REFERENCES file_folders(workspace_id, id) ON DELETE RESTRICT,
  CHECK(revoked_at IS NULL OR NOT is_active)
);
CREATE INDEX file_public_links_resource ON file_public_links(workspace_id, resource_type, resource_id);
CREATE FUNCTION file_public_link_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.workspace_id <> OLD.workspace_id OR NEW.resource_type <> OLD.resource_type OR NEW.resource_id <> OLD.resource_id OR
    NEW.token_hash <> OLD.token_hash OR NEW.created_by_user_id <> OLD.created_by_user_id OR NEW.resource_share_version <> OLD.resource_share_version OR
    NEW.created_at <> OLD.created_at OR NEW.download_count < OLD.download_count OR NEW.access_count < OLD.access_count OR
    OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.is_active)) THEN
    RAISE EXCEPTION 'PUBLIC_LINK_REVOKED' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM workspace_memberships WHERE workspace_id = NEW.workspace_id AND user_id = NEW.created_by_user_id) THEN
    RAISE EXCEPTION 'PUBLIC_LINK_NOT_FOUND' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER file_public_link_guard BEFORE INSERT OR UPDATE ON file_public_links FOR EACH ROW EXECUTE FUNCTION file_public_link_guard();
CREATE TRIGGER file_public_link_revision BEFORE INSERT OR UPDATE OR DELETE ON file_public_links FOR EACH ROW EXECUTE FUNCTION calendar_booking_source_epoch();
