CREATE TABLE collaboration_chats (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  type TEXT NOT NULL CHECK (type IN ('TASK', 'PROJECT')),
  title TEXT NOT NULL,
  linked_task_id UUID UNIQUE,
  linked_project_id UUID UNIQUE,
  created_by_user_id UUID NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ(6) NOT NULL,
  updated_at TIMESTAMPTZ(6) NOT NULL,
  UNIQUE(workspace_id, id),
  FOREIGN KEY(workspace_id, linked_task_id) REFERENCES tasks(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id, linked_project_id) REFERENCES projects(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id, created_by_user_id) REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE RESTRICT,
  CHECK ((type = 'TASK' AND linked_project_id IS NULL) OR (type = 'PROJECT' AND linked_task_id IS NULL))
);
CREATE TABLE collaboration_chat_members (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  chat_id UUID NOT NULL,
  user_id UUID NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('MEMBER', 'ADMIN')),
  joined_at TIMESTAMPTZ(6) NOT NULL,
  left_at TIMESTAMPTZ(6),
  UNIQUE(chat_id, user_id),
  FOREIGN KEY(workspace_id, chat_id) REFERENCES collaboration_chats(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id, user_id) REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE RESTRICT
);
CREATE TABLE collaboration_chat_membership_sources (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  chat_id UUID NOT NULL,
  user_id UUID NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('TASK', 'PROJECT', 'MANUAL', 'SYSTEM')),
  source_id UUID NOT NULL,
  active BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL,
  updated_at TIMESTAMPTZ(6) NOT NULL,
  UNIQUE(chat_id, user_id, source_type, source_id),
  FOREIGN KEY(workspace_id, chat_id) REFERENCES collaboration_chats(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id, user_id) REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE RESTRICT
);

-- Historical Tasks also receive the same canonical resource as newly created Tasks.
INSERT INTO collaboration_chats (id, workspace_id, type, title, linked_task_id, created_by_user_id, status, created_at, updated_at)
SELECT gen_random_uuid(), workspace_id, 'TASK', title, id, created_by_user_id,
  CASE WHEN is_deleted THEN 'ARCHIVED' ELSE 'ACTIVE' END, created_at, updated_at FROM tasks;
INSERT INTO collaboration_chat_membership_sources (id, workspace_id, chat_id, user_id, source_type, source_id, active, created_at, updated_at)
SELECT gen_random_uuid(), c.workspace_id, c.id, audience.user_id, 'TASK', c.linked_task_id, TRUE, c.created_at, c.updated_at
FROM collaboration_chats c JOIN (
  SELECT id AS task_id, created_by_user_id AS user_id FROM tasks
  UNION SELECT id, responsible_user_id FROM tasks
  UNION SELECT task_id, user_id FROM task_members
) audience ON audience.task_id = c.linked_task_id
JOIN workspace_memberships wm ON wm.workspace_id = c.workspace_id AND wm.user_id = audience.user_id;
INSERT INTO collaboration_chat_members (id, workspace_id, chat_id, user_id, role, joined_at)
SELECT gen_random_uuid(), s.workspace_id, s.chat_id, s.user_id,
  CASE WHEN s.user_id = c.created_by_user_id THEN 'ADMIN' ELSE 'MEMBER' END, c.created_at
FROM collaboration_chat_membership_sources s JOIN collaboration_chats c ON c.id = s.chat_id;
