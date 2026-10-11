CREATE TABLE file_storages (
  id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  type TEXT NOT NULL CHECK (type = 'PROJECT'), owner_user_id UUID, project_id UUID UNIQUE,
  name TEXT NOT NULL, is_active BOOLEAN NOT NULL, is_read_only BOOLEAN NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0), created_at TIMESTAMPTZ(6) NOT NULL, updated_at TIMESTAMPTZ(6) NOT NULL,
  UNIQUE(workspace_id, id),
  FOREIGN KEY(workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id, owner_user_id) REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE RESTRICT
);
CREATE TABLE file_folders (
  id UUID PRIMARY KEY, workspace_id UUID NOT NULL, storage_id UUID NOT NULL UNIQUE,
  parent_folder_id UUID CHECK (parent_folder_id IS NULL), name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status = 'ACTIVE'), original_parent_folder_id UUID,
  trashed_at TIMESTAMPTZ(6), purge_after TIMESTAMPTZ(6), version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ(6) NOT NULL, updated_at TIMESTAMPTZ(6) NOT NULL,
  UNIQUE(workspace_id, id),
  FOREIGN KEY(workspace_id, storage_id) REFERENCES file_storages(workspace_id, id) ON DELETE RESTRICT
);
CREATE TABLE storage_access_sources (
  id UUID PRIMARY KEY, workspace_id UUID NOT NULL, storage_id UUID NOT NULL, user_id UUID NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('PROJECT', 'MANUAL', 'SYSTEM')), source_id UUID NOT NULL,
  permission_level TEXT NOT NULL CHECK (permission_level IN ('READ', 'ADD', 'EDIT', 'FULL')), active BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL, updated_at TIMESTAMPTZ(6) NOT NULL,
  UNIQUE(storage_id, user_id, source_type, source_id),
  FOREIGN KEY(workspace_id, storage_id) REFERENCES file_storages(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id, user_id) REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE RESTRICT
);
