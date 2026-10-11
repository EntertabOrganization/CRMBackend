-- Final-state constraints allow atomic replacement (insert new assignments, remove old ones).
ALTER TABLE file_permission_assignments ADD CONSTRAINT file_permission_subject_unique
  UNIQUE NULLS NOT DISTINCT (workspace_id, resource_type, resource_id, subject_type, subject_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION file_permission_mode_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE scope UUID; resource UUID; kind TEXT;
BEGIN
  scope := COALESCE(NEW.workspace_id, OLD.workspace_id);
  resource := COALESCE(NEW.resource_id, OLD.resource_id);
  kind := COALESCE(NEW.resource_type, OLD.resource_type);
  IF (SELECT COUNT(DISTINCT inheritance_mode) FROM file_permission_assignments
      WHERE workspace_id = scope AND resource_id = resource AND resource_type = kind) > 1 THEN
    RAISE EXCEPTION 'FILE_PERMISSION_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER file_permission_mode_guard AFTER INSERT OR UPDATE OR DELETE ON file_permission_assignments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION file_permission_mode_guard();

CREATE FUNCTION file_permission_live_subject_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE storage UUID;
BEGIN
  IF NEW.subject_type = 'WORKSPACE' AND NEW.subject_id = NEW.workspace_id::text THEN NEW.subject_id := NULL; END IF;
  IF NEW.resource_type = 'STORAGE' THEN storage := NEW.resource_id;
  ELSE SELECT storage_id INTO storage FROM file_folders WHERE id = NEW.resource_id AND workspace_id = NEW.workspace_id; END IF;
  IF (NEW.subject_type = 'USER' AND NOT EXISTS(SELECT 1 FROM workspace_memberships m JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = NEW.workspace_id AND m.user_id::text = NEW.subject_id AND m.status = 'ACTIVE' AND u.status = 'ACTIVE' AND NOT u.is_deleted)) OR
    (NEW.subject_type = 'ROLE' AND NOT EXISTS(SELECT 1 FROM roles WHERE id::text = NEW.subject_id AND workspace_id = NEW.workspace_id AND NOT is_deleted)) OR
    (NEW.subject_type IN ('DEPARTMENT','DEPARTMENT_TREE') AND NOT EXISTS(SELECT 1 FROM departments WHERE id::text = NEW.subject_id AND workspace_id = NEW.workspace_id AND NOT is_deleted)) OR
    (NEW.subject_type = 'PROJECT_ROLE' AND NOT EXISTS(SELECT 1 FROM file_storages s JOIN projects p ON p.id = s.project_id
      WHERE s.id = storage AND s.workspace_id = NEW.workspace_id AND p.workspace_id = NEW.workspace_id AND NOT p.is_deleted)) OR
    (NEW.subject_type = 'EXTERNAL_GUEST' AND NOT EXISTS(SELECT 1 FROM collab_space_members m JOIN collab_spaces c ON c.id = m.collab_id
      WHERE m.workspace_id = NEW.workspace_id AND c.workspace_id = NEW.workspace_id AND m.user_id::text = NEW.subject_id
        AND m.member_type = 'EXTERNAL' AND m.status = 'ACTIVE' AND m.left_at IS NULL AND c.status = 'ACTIVE')) THEN
    RAISE EXCEPTION 'FILE_PERMISSION_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER file_permission_live_subject_guard BEFORE INSERT OR UPDATE ON file_permission_assignments
  FOR EACH ROW EXECUTE FUNCTION file_permission_live_subject_guard();
