CREATE TABLE collab_spaces (
  id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  name TEXT NOT NULL, owner_user_id UUID NOT NULL, status TEXT NOT NULL CHECK(status IN ('ACTIVE', 'ARCHIVED')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0), UNIQUE(workspace_id, id),
  FOREIGN KEY(workspace_id, owner_user_id) REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE RESTRICT
);
CREATE TABLE collab_space_members (
  id UUID PRIMARY KEY, workspace_id UUID NOT NULL, collab_id UUID NOT NULL, user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  member_type TEXT NOT NULL CHECK(member_type IN ('INTERNAL', 'EXTERNAL')),
  role TEXT NOT NULL CHECK(role IN ('OWNER', 'ADMIN', 'MEMBER', 'GUEST')),
  status TEXT NOT NULL CHECK(status IN ('INVITED', 'ACTIVE', 'REMOVED')), joined_at TIMESTAMPTZ(6), left_at TIMESTAMPTZ(6),
  UNIQUE(collab_id, user_id), FOREIGN KEY(workspace_id, collab_id) REFERENCES collab_spaces(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX collab_space_member_authority ON collab_space_members(workspace_id, user_id) WHERE status = 'ACTIVE' AND left_at IS NULL;
CREATE FUNCTION collab_space_member_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.member_type = 'INTERNAL' AND NOT EXISTS(SELECT 1 FROM workspace_memberships WHERE workspace_id = NEW.workspace_id AND user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'CHAT_MEMBER_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER collab_space_member_guard BEFORE INSERT OR UPDATE ON collab_space_members FOR EACH ROW EXECUTE FUNCTION collab_space_member_guard();

ALTER TABLE collaboration_chats DROP CONSTRAINT collaboration_chats_type_check, DROP CONSTRAINT collaboration_chats_check;
ALTER TABLE collaboration_chats ALTER COLUMN title DROP NOT NULL;
ALTER TABLE collaboration_chats ADD COLUMN linked_department_id UUID UNIQUE, ADD COLUMN linked_collab_id UUID UNIQUE;
ALTER TABLE collaboration_chats ADD CHECK(type IN ('DIRECT','GROUP','TASK','PROJECT','DEPARTMENT','COLLAB')),
  ADD CHECK(num_nonnulls(linked_task_id, linked_project_id, linked_department_id, linked_collab_id) <= 1),
  ADD CHECK((linked_task_id IS NULL OR type = 'TASK') AND (linked_project_id IS NULL OR type = 'PROJECT') AND
    (linked_department_id IS NULL OR type = 'DEPARTMENT') AND (linked_collab_id IS NULL OR type = 'COLLAB')),
  ADD CHECK(type NOT IN ('DEPARTMENT','COLLAB') OR num_nonnulls(linked_department_id, linked_collab_id) = 1),
  ADD FOREIGN KEY(workspace_id, linked_department_id) REFERENCES departments(workspace_id, id) ON DELETE RESTRICT,
  ADD FOREIGN KEY(workspace_id, linked_collab_id) REFERENCES collab_spaces(workspace_id, id) ON DELETE RESTRICT;
ALTER TABLE collaboration_chat_members DROP CONSTRAINT collaboration_chat_members_role_check;
ALTER TABLE collaboration_chat_members ADD CHECK(role IN ('ADMIN','MEMBER','BOT'));
ALTER TABLE collaboration_chat_members ADD COLUMN last_read_message_id UUID;
ALTER TABLE collaboration_chat_membership_sources DROP CONSTRAINT collaboration_chat_membership_sources_source_type_check;
ALTER TABLE collaboration_chat_membership_sources ADD CHECK(source_type IN ('TASK','PROJECT','DEPARTMENT','COLLAB','MANUAL','SYSTEM'));
DO $$ DECLARE row RECORD; BEGIN
  FOR row IN SELECT conname, conrelid::regclass tab FROM pg_constraint WHERE contype = 'f' AND
    conrelid IN ('collaboration_chat_members'::regclass, 'collaboration_chat_membership_sources'::regclass) AND confrelid = 'workspace_memberships'::regclass
  LOOP EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', row.tab, row.conname); END LOOP;
END $$;
ALTER TABLE collaboration_chat_members ADD FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE collaboration_chat_membership_sources ADD FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE RESTRICT;

CREATE TABLE direct_chat_pairs (
  id UUID PRIMARY KEY, workspace_id UUID NOT NULL, chat_id UUID NOT NULL UNIQUE,
  user_a_id UUID NOT NULL, user_b_id UUID NOT NULL, CHECK(user_a_id < user_b_id),
  UNIQUE(workspace_id, user_a_id, user_b_id), FOREIGN KEY(workspace_id, chat_id) REFERENCES collaboration_chats(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id, user_a_id) REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id, user_b_id) REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE RESTRICT
);

CREATE FUNCTION collaboration_chat_member_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE chat collaboration_chats%ROWTYPE;
BEGIN
  SELECT * INTO chat FROM collaboration_chats WHERE id = NEW.chat_id AND workspace_id = NEW.workspace_id;
  IF chat.id IS NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS(SELECT 1 FROM workspace_memberships WHERE workspace_id = NEW.workspace_id AND user_id = NEW.user_id) AND
    NOT (chat.type = 'COLLAB' AND EXISTS(SELECT 1 FROM collab_space_members WHERE collab_id = chat.linked_collab_id AND workspace_id = NEW.workspace_id AND user_id = NEW.user_id AND member_type = 'EXTERNAL')) THEN
    RAISE EXCEPTION 'CHAT_MEMBER_INVALID' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'collaboration_chat_membership_sources' THEN
    IF (chat.type = 'TASK' AND NEW.source_type = 'MANUAL') OR
      (chat.type = 'DEPARTMENT' AND (NEW.source_type <> 'DEPARTMENT' OR NEW.source_id <> chat.linked_department_id)) OR
      (chat.type = 'COLLAB' AND (NEW.source_type <> 'COLLAB' OR NEW.source_id <> chat.linked_collab_id)) OR
      (chat.type = 'DIRECT' AND (NEW.source_type <> 'SYSTEM' OR NEW.source_id <> chat.id OR NOT EXISTS(
        SELECT 1 FROM direct_chat_pairs WHERE chat_id = chat.id AND NEW.user_id IN (user_a_id, user_b_id)))) THEN
      RAISE EXCEPTION 'CHAT_MEMBERSHIP_SOURCE_PROTECTED' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER collaboration_chat_member_guard BEFORE INSERT OR UPDATE ON collaboration_chat_members FOR EACH ROW EXECUTE FUNCTION collaboration_chat_member_guard();
CREATE TRIGGER collaboration_chat_source_guard BEFORE INSERT OR UPDATE ON collaboration_chat_membership_sources FOR EACH ROW EXECUTE FUNCTION collaboration_chat_member_guard();
CREATE FUNCTION direct_chat_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target UUID; chat collaboration_chats%ROWTYPE; pair direct_chat_pairs%ROWTYPE;
BEGIN
  target := CASE WHEN TG_TABLE_NAME = 'collaboration_chats' THEN NEW.id ELSE COALESCE((to_jsonb(NEW)->>'chat_id')::uuid, (to_jsonb(OLD)->>'chat_id')::uuid) END;
  SELECT * INTO chat FROM collaboration_chats WHERE id = target;
  SELECT * INTO pair FROM direct_chat_pairs WHERE chat_id = target;
  IF (chat.type = 'DIRECT' AND pair.id IS NULL) OR (pair.id IS NOT NULL AND chat.type <> 'DIRECT') OR
    (chat.type = 'DIRECT' AND (chat.created_by_user_id NOT IN (pair.user_a_id, pair.user_b_id) OR
      EXISTS(SELECT 1 FROM collaboration_chat_members WHERE chat_id = target AND user_id NOT IN (pair.user_a_id, pair.user_b_id)) OR
      (SELECT count(*) FROM collaboration_chat_members WHERE chat_id = target AND user_id IN (pair.user_a_id, pair.user_b_id) AND left_at IS NULL) <> 2 OR
      (SELECT count(*) FROM collaboration_chat_membership_sources WHERE chat_id = target AND source_type = 'SYSTEM' AND source_id = target AND active AND user_id IN (pair.user_a_id, pair.user_b_id)) <> 2)) THEN
    RAISE EXCEPTION 'CHAT_MEMBERSHIP_SOURCE_PROTECTED' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER direct_chat_consistency AFTER INSERT OR UPDATE ON collaboration_chats DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION direct_chat_consistency();
CREATE CONSTRAINT TRIGGER direct_pair_consistency AFTER INSERT OR UPDATE OR DELETE ON direct_chat_pairs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION direct_chat_consistency();
CREATE CONSTRAINT TRIGGER direct_member_consistency AFTER INSERT OR UPDATE ON collaboration_chat_members DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION direct_chat_consistency();
CREATE CONSTRAINT TRIGGER direct_member_delete_consistency AFTER DELETE ON collaboration_chat_members DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION direct_chat_consistency();
CREATE CONSTRAINT TRIGGER direct_source_consistency AFTER INSERT OR UPDATE OR DELETE ON collaboration_chat_membership_sources DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION direct_chat_consistency();

ALTER TABLE file_storages DROP CONSTRAINT file_storages_type_check;
ALTER TABLE file_storages ADD CHECK(type IN ('PERSONAL','COMPANY','PROJECT','SYSTEM')),
  ADD CHECK((type = 'PERSONAL' AND owner_user_id IS NOT NULL AND project_id IS NULL) OR
    (type = 'PROJECT' AND owner_user_id IS NULL) OR (type IN ('COMPANY','SYSTEM') AND owner_user_id IS NULL AND project_id IS NULL));
CREATE UNIQUE INDEX file_storage_personal_canonical ON file_storages(workspace_id, owner_user_id) WHERE type = 'PERSONAL';
CREATE UNIQUE INDEX file_storage_company_canonical ON file_storages(workspace_id) WHERE type = 'COMPANY';
ALTER TABLE file_folders DROP CONSTRAINT file_folders_storage_id_key, DROP CONSTRAINT file_folders_parent_folder_id_check, DROP CONSTRAINT file_folders_status_check;
ALTER TABLE file_folders ADD CHECK(status IN ('ACTIVE','TRASHED')), ADD UNIQUE(workspace_id, storage_id, id),
  ADD FOREIGN KEY(workspace_id, storage_id, parent_folder_id) REFERENCES file_folders(workspace_id, storage_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CHECK(parent_folder_id IS DISTINCT FROM id), ADD CHECK(parent_folder_id IS NOT NULL OR status = 'ACTIVE');
CREATE UNIQUE INDEX file_folder_root_canonical ON file_folders(storage_id) WHERE parent_folder_id IS NULL;
CREATE UNIQUE INDEX file_folder_sibling_name ON file_folders(storage_id, parent_folder_id, lower(btrim(normalize(name, NFC)) COLLATE "und-x-icu")) WHERE status = 'ACTIVE' AND parent_folder_id IS NOT NULL;
CREATE INDEX file_folder_parent ON file_folders(workspace_id, storage_id, parent_folder_id);
CREATE FUNCTION file_folder_graph_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target UUID; storage UUID; scope UUID; cursor UUID; seen UUID[] := '{}'; folder file_folders%ROWTYPE;
BEGIN
  target := COALESCE(NEW.id, OLD.id);
  SELECT * INTO folder FROM file_folders WHERE id = target;
  IF folder.id IS NULL THEN RETURN NULL; END IF;
  storage := folder.storage_id; scope := folder.workspace_id; cursor := folder.id;
  WHILE cursor IS NOT NULL LOOP
    IF cursor = ANY(seen) THEN RAISE EXCEPTION 'FOLDER_HIERARCHY_CYCLE' USING ERRCODE = '23514'; END IF;
    seen := array_append(seen, cursor);
    SELECT * INTO folder FROM file_folders WHERE id = cursor AND storage_id = storage AND workspace_id = scope;
    IF folder.id IS NULL THEN RAISE EXCEPTION 'FOLDER_NOT_FOUND' USING ERRCODE = '23514'; END IF;
    cursor := folder.parent_folder_id;
  END LOOP;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER file_folder_graph_guard AFTER INSERT OR UPDATE ON file_folders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION file_folder_graph_guard();
CREATE FUNCTION file_folder_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM file_storages WHERE id = NEW.storage_id AND workspace_id = NEW.workspace_id FOR UPDATE;
  IF TG_OP = 'UPDATE' AND (NEW.storage_id <> OLD.storage_id OR NEW.workspace_id <> OLD.workspace_id OR
    (OLD.parent_folder_id IS NULL AND NEW.parent_folder_id IS NOT NULL)) THEN RAISE EXCEPTION 'FOLDER_HIERARCHY_CYCLE' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER file_folder_lock BEFORE INSERT OR UPDATE ON file_folders FOR EACH ROW EXECUTE FUNCTION file_folder_lock();
CREATE FUNCTION file_storage_root_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target UUID;
BEGIN
  target := CASE WHEN TG_TABLE_NAME = 'file_storages' THEN (to_jsonb(NEW)->>'id')::uuid
    ELSE COALESCE((to_jsonb(NEW)->>'storage_id')::uuid, (to_jsonb(OLD)->>'storage_id')::uuid) END;
  IF EXISTS(SELECT 1 FROM file_storages WHERE id = target) AND
    (SELECT count(*) FROM file_folders WHERE storage_id = target AND parent_folder_id IS NULL AND status = 'ACTIVE') <> 1 THEN
    RAISE EXCEPTION 'FOLDER_NOT_FOUND' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER file_storage_root_guard AFTER INSERT OR UPDATE ON file_storages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION file_storage_root_guard();
CREATE CONSTRAINT TRIGGER file_folder_root_guard AFTER INSERT OR UPDATE OR DELETE ON file_folders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION file_storage_root_guard();

CREATE TABLE file_permission_assignments (
  id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  resource_type TEXT NOT NULL CHECK(resource_type IN ('STORAGE','FOLDER')), resource_id UUID NOT NULL,
  subject_type TEXT NOT NULL CHECK(subject_type IN ('USER','ROLE','DEPARTMENT','DEPARTMENT_TREE','PROJECT_ROLE','WORKSPACE','EXTERNAL_GUEST')),
  subject_id TEXT, permission_level TEXT NOT NULL CHECK(permission_level IN ('NONE','READ','ADD','EDIT','FULL')),
  inheritance_mode TEXT NOT NULL CHECK(inheritance_mode IN ('INHERIT','OVERRIDE'))
);
CREATE INDEX file_permission_resource ON file_permission_assignments(workspace_id, resource_type, resource_id);
CREATE FUNCTION file_permission_tenant_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.resource_type = 'STORAGE' AND NOT EXISTS(SELECT 1 FROM file_storages WHERE id = NEW.resource_id AND workspace_id = NEW.workspace_id)) OR
    (NEW.resource_type = 'FOLDER' AND NOT EXISTS(SELECT 1 FROM file_folders WHERE id = NEW.resource_id AND workspace_id = NEW.workspace_id)) OR
    (NEW.subject_type = 'USER' AND NOT EXISTS(SELECT 1 FROM workspace_memberships WHERE user_id::text = NEW.subject_id AND workspace_id = NEW.workspace_id)) OR
    (NEW.subject_type = 'ROLE' AND NOT EXISTS(SELECT 1 FROM roles WHERE id::text = NEW.subject_id AND workspace_id = NEW.workspace_id)) OR
    (NEW.subject_type IN ('DEPARTMENT','DEPARTMENT_TREE') AND NOT EXISTS(SELECT 1 FROM departments WHERE id::text = NEW.subject_id AND workspace_id = NEW.workspace_id)) OR
    (NEW.subject_type = 'WORKSPACE' AND NEW.subject_id IS NOT NULL AND NEW.subject_id <> NEW.workspace_id::text) OR
    (NEW.subject_type = 'PROJECT_ROLE' AND (NEW.subject_id IS NULL OR NEW.subject_id NOT IN ('OWNER','MODERATOR','MEMBER','OBSERVER'))) OR
    (NEW.subject_type = 'EXTERNAL_GUEST' AND NOT EXISTS(SELECT 1 FROM users WHERE id::text = NEW.subject_id)) THEN
    RAISE EXCEPTION 'FILE_PERMISSION_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER file_permission_tenant_guard BEFORE INSERT OR UPDATE ON file_permission_assignments FOR EACH ROW EXECUTE FUNCTION file_permission_tenant_guard();
