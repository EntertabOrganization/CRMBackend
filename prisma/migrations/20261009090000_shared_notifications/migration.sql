CREATE TABLE user_notifications (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  recipient_user_id UUID NOT NULL,
  notification_type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  link TEXT,
  idempotency_key TEXT NOT NULL,
  read_at TIMESTAMPTZ(3),
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id, recipient_user_id) REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE RESTRICT,
  UNIQUE (workspace_id, recipient_user_id, idempotency_key)
);
CREATE INDEX user_notifications_workspace_id_recipient_user_id_created_at_idx ON user_notifications(workspace_id, recipient_user_id, created_at);
CREATE TABLE notification_preferences (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  user_id UUID NOT NULL,
  notification_type TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('IN_APP', 'EMAIL', 'PUSH')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  FOREIGN KEY (workspace_id, user_id) REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE RESTRICT,
  UNIQUE (workspace_id, user_id, notification_type, channel)
);
