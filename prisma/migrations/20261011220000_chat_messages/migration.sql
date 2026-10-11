-- Durable Chat Messages, immutable edit history, reactions/pins/favorites, read model, drafts and source-object bindings.
CREATE TABLE chat_messages (
 id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT, chat_id UUID NOT NULL,
 sequence INTEGER NOT NULL CHECK(sequence > 0), sender_type TEXT NOT NULL CHECK(sender_type IN ('USER','SYSTEM','BOT')), sender_id UUID REFERENCES users(id) ON DELETE RESTRICT,
 client_message_id TEXT NOT NULL CHECK(client_message_id ~ '^[A-Za-z0-9._:-]{1,100}$'), request_hash TEXT NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 message_type TEXT NOT NULL CHECK(message_type IN ('TEXT','FILE','VOICE','VIDEO','SYSTEM')), body TEXT CHECK(body IS NULL OR length(body) <= 10000),
 file_ids UUID[] NOT NULL CHECK(cardinality(file_ids) <= 10), reply_to_message_id UUID,
 status TEXT NOT NULL CHECK(status IN ('ACTIVE','DELETED')), sent_at TIMESTAMPTZ NOT NULL, edited_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ,
 deleted_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT, version INTEGER NOT NULL CHECK(version > 0),
 created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
 UNIQUE(chat_id, sequence), UNIQUE(chat_id, sender_id, client_message_id), UNIQUE(workspace_id, id), UNIQUE(workspace_id, chat_id, id),
 FOREIGN KEY(workspace_id, chat_id) REFERENCES collaboration_chats(workspace_id, id) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id, chat_id, reply_to_message_id) REFERENCES chat_messages(workspace_id, chat_id, id) DEFERRABLE INITIALLY DEFERRED,
 CHECK(sender_type <> 'USER' OR sender_id IS NOT NULL),
 CHECK((status = 'DELETED') = (deleted_at IS NOT NULL) AND (status <> 'DELETED' OR body IS NULL AND cardinality(file_ids) = 0)),
 CHECK(status <> 'ACTIVE' OR message_type <> 'TEXT' OR body IS NOT NULL AND cardinality(file_ids) = 0),
 CHECK(status <> 'ACTIVE' OR message_type NOT IN ('FILE','VOICE','VIDEO') OR cardinality(file_ids) > 0),
 CHECK(reply_to_message_id IS NULL OR reply_to_message_id <> id)
);
CREATE INDEX chat_messages_chat_sequence ON chat_messages(chat_id, sequence DESC);

CREATE FUNCTION chat_message_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE chat collaboration_chats%ROWTYPE;
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'CHAT_MESSAGE_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF TG_OP = 'INSERT' AND NOT EXISTS(SELECT 1 FROM chat_messages WHERE id = NEW.id) THEN
  SELECT * INTO chat FROM collaboration_chats WHERE id = NEW.chat_id AND workspace_id = NEW.workspace_id;
  IF NOT FOUND OR chat.status <> 'ACTIVE' OR NEW.status <> 'ACTIVE' OR NEW.version <> 1 OR NEW.edited_at IS NOT NULL OR
    EXISTS(SELECT 1 FROM chat_messages WHERE chat_id = NEW.chat_id AND sequence >= NEW.sequence) OR
    NEW.sender_type = 'USER' AND NOT EXISTS(SELECT 1 FROM users u WHERE u.id = NEW.sender_id AND u.status = 'ACTIVE' AND NOT u.is_deleted AND (
      EXISTS(SELECT 1 FROM workspace_memberships m WHERE m.workspace_id = NEW.workspace_id AND m.user_id = u.id AND m.status = 'ACTIVE' AND NOT m.is_deleted) OR
      chat.type = 'COLLAB' AND EXISTS(SELECT 1 FROM collab_space_members c WHERE c.workspace_id = NEW.workspace_id AND c.collab_id = chat.linked_collab_id AND c.user_id = u.id AND c.status = 'ACTIVE')))
  THEN RAISE EXCEPTION 'CHAT_MESSAGE_INVALID' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP = 'UPDATE' AND (NEW.workspace_id <> OLD.workspace_id OR NEW.chat_id <> OLD.chat_id OR NEW.sequence <> OLD.sequence OR NEW.sender_type <> OLD.sender_type OR
   NEW.sender_id IS DISTINCT FROM OLD.sender_id OR NEW.client_message_id <> OLD.client_message_id OR NEW.request_hash <> OLD.request_hash OR
   NEW.message_type <> OLD.message_type OR NEW.reply_to_message_id IS DISTINCT FROM OLD.reply_to_message_id OR NEW.sent_at <> OLD.sent_at OR
   NEW.created_at <> OLD.created_at OR NEW.version < OLD.version OR OLD.status = 'DELETED' AND NEW IS DISTINCT FROM OLD OR
   NEW.status = 'ACTIVE' AND NEW.body IS DISTINCT FROM OLD.body AND (NEW.version <= OLD.version OR NEW.edited_at IS NOT DISTINCT FROM OLD.edited_at) OR
   NEW.status = 'ACTIVE' AND NEW.file_ids IS DISTINCT FROM OLD.file_ids)
 THEN RAISE EXCEPTION 'CHAT_MESSAGE_IMMUTABLE' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER chat_message_guard BEFORE INSERT OR UPDATE OR DELETE ON chat_messages FOR EACH ROW EXECUTE FUNCTION chat_message_guard();

CREATE TABLE chat_message_versions (
 id UUID PRIMARY KEY, workspace_id UUID NOT NULL, message_id UUID NOT NULL, version_number INTEGER NOT NULL CHECK(version_number > 0),
 body TEXT CHECK(body IS NULL OR length(body) <= 10000), edited_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, created_at TIMESTAMPTZ NOT NULL,
 UNIQUE(message_id, version_number), FOREIGN KEY(workspace_id, message_id) REFERENCES chat_messages(workspace_id, id) ON DELETE RESTRICT
);
-- Edits are only valid when the pre-edit body was preserved as history in the same transaction.
CREATE FUNCTION chat_message_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status = 'ACTIVE' AND NEW.body IS DISTINCT FROM OLD.body AND NOT EXISTS(SELECT 1 FROM chat_message_versions v WHERE v.message_id = NEW.id
   AND v.workspace_id = NEW.workspace_id AND v.version_number = OLD.version AND v.body IS NOT DISTINCT FROM OLD.body) THEN
  RAISE EXCEPTION 'CHAT_MESSAGE_IMMUTABLE' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER chat_message_history_guard AFTER UPDATE ON chat_messages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION chat_message_history_guard();

CREATE TABLE chat_message_reactions (
 id UUID PRIMARY KEY, workspace_id UUID NOT NULL, message_id UUID NOT NULL, user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 reaction TEXT NOT NULL CHECK(length(reaction) BETWEEN 1 AND 64), created_at TIMESTAMPTZ NOT NULL,
 UNIQUE(message_id, user_id, reaction), FOREIGN KEY(workspace_id, message_id) REFERENCES chat_messages(workspace_id, id) ON DELETE RESTRICT
);
CREATE TABLE chat_message_pins (
 id UUID PRIMARY KEY, workspace_id UUID NOT NULL, chat_id UUID NOT NULL, message_id UUID NOT NULL UNIQUE,
 pinned_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, created_at TIMESTAMPTZ NOT NULL,
 FOREIGN KEY(workspace_id, chat_id, message_id) REFERENCES chat_messages(workspace_id, chat_id, id) ON DELETE RESTRICT
);
CREATE TABLE chat_message_favorites (
 id UUID PRIMARY KEY, workspace_id UUID NOT NULL, message_id UUID NOT NULL, user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, created_at TIMESTAMPTZ NOT NULL,
 UNIQUE(message_id, user_id), FOREIGN KEY(workspace_id, message_id) REFERENCES chat_messages(workspace_id, id) ON DELETE RESTRICT
);
CREATE TABLE chat_message_reads (
 id UUID PRIMARY KEY, workspace_id UUID NOT NULL, chat_id UUID NOT NULL, message_id UUID NOT NULL, user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 read_at TIMESTAMPTZ NOT NULL, UNIQUE(message_id, user_id),
 FOREIGN KEY(workspace_id, chat_id, message_id) REFERENCES chat_messages(workspace_id, chat_id, id) ON DELETE RESTRICT
);
CREATE TABLE chat_read_states (
 id UUID PRIMARY KEY, workspace_id UUID NOT NULL, chat_id UUID NOT NULL, user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 last_read_sequence INTEGER NOT NULL CHECK(last_read_sequence >= 0), last_read_message_id UUID, updated_at TIMESTAMPTZ NOT NULL,
 UNIQUE(chat_id, user_id), FOREIGN KEY(workspace_id, chat_id) REFERENCES collaboration_chats(workspace_id, id) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id, chat_id, last_read_message_id) REFERENCES chat_messages(workspace_id, chat_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE chat_drafts (
 id UUID PRIMARY KEY, workspace_id UUID NOT NULL, chat_id UUID NOT NULL, user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 body TEXT NOT NULL CHECK(length(body) <= 10000), reply_to_message_id UUID, version INTEGER NOT NULL CHECK(version > 0),
 created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL, UNIQUE(chat_id, user_id),
 FOREIGN KEY(workspace_id, chat_id) REFERENCES collaboration_chats(workspace_id, id) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id, chat_id, reply_to_message_id) REFERENCES chat_messages(workspace_id, chat_id, id) ON DELETE RESTRICT
);
CREATE TABLE communication_bindings (
 id UUID PRIMARY KEY, workspace_id UUID NOT NULL, source_type TEXT NOT NULL CHECK(source_type = 'CHAT_MESSAGE'), source_id UUID NOT NULL, chat_id UUID NOT NULL,
 target_type TEXT NOT NULL CHECK(target_type IN ('TASK','CALENDAR_EVENT')), target_id UUID NOT NULL,
 created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, created_at TIMESTAMPTZ NOT NULL,
 UNIQUE(source_id, target_type, target_id), FOREIGN KEY(workspace_id, chat_id, source_id) REFERENCES chat_messages(workspace_id, chat_id, id) ON DELETE RESTRICT
);

-- Per-user rows belong to an active member of the same Workspace; history and receipts are append-only;
-- read positions only move forward; reactions, pins and bindings attach to live Messages only.
CREATE FUNCTION chat_message_child_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row JSONB; subject UUID; message UUID; target_valid BOOLEAN;
BEGIN
 IF TG_TABLE_NAME IN ('chat_message_versions','chat_message_reads','communication_bindings') AND (TG_OP = 'DELETE' OR TG_OP = 'UPDATE' AND NEW IS DISTINCT FROM OLD) THEN
  RAISE EXCEPTION 'CHAT_MESSAGE_IMMUTABLE' USING ERRCODE='23514';
 END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 row := to_jsonb(NEW);
 IF TG_TABLE_NAME = 'chat_read_states' THEN
  IF TG_OP = 'UPDATE' AND ((row->>'last_read_sequence')::int < (to_jsonb(OLD)->>'last_read_sequence')::int OR row->>'user_id' <> to_jsonb(OLD)->>'user_id'
    OR row->>'chat_id' <> to_jsonb(OLD)->>'chat_id') THEN
   RAISE EXCEPTION 'CHAT_READ_POSITION_INVALID' USING ERRCODE='23514';
  END IF;
  IF (row->>'last_read_message_id' IS NULL) <> ((row->>'last_read_sequence')::int = 0) OR row->>'last_read_message_id' IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM chat_messages m WHERE m.id = (row->>'last_read_message_id')::uuid AND m.sequence = (row->>'last_read_sequence')::int) THEN
   RAISE EXCEPTION 'CHAT_READ_POSITION_INVALID' USING ERRCODE='23514';
  END IF;
 END IF;
 IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
 subject := (row->>CASE TG_TABLE_NAME WHEN 'chat_message_versions' THEN 'edited_by_user_id' WHEN 'chat_message_pins' THEN 'pinned_by_user_id'
   WHEN 'communication_bindings' THEN 'created_by_user_id' ELSE 'user_id' END)::uuid;
 IF NOT EXISTS(SELECT 1 FROM workspace_memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = (row->>'workspace_id')::uuid AND m.user_id = subject AND m.status = 'ACTIVE' AND NOT u.is_deleted)
   AND NOT EXISTS(SELECT 1 FROM collab_space_members c WHERE c.workspace_id = (row->>'workspace_id')::uuid AND c.user_id = subject AND c.status = 'ACTIVE') THEN
  RAISE EXCEPTION 'CHAT_MESSAGE_INVALID' USING ERRCODE='23514';
 END IF;
 IF TG_TABLE_NAME IN ('chat_message_reactions','chat_message_pins','communication_bindings') THEN
  message := (row->>CASE TG_TABLE_NAME WHEN 'communication_bindings' THEN 'source_id' ELSE 'message_id' END)::uuid;
  IF NOT EXISTS(SELECT 1 FROM chat_messages WHERE id = message AND workspace_id = (row->>'workspace_id')::uuid AND status = 'ACTIVE') THEN
   RAISE EXCEPTION 'CHAT_MESSAGE_INVALID' USING ERRCODE='23514';
  END IF;
 END IF;
 IF TG_TABLE_NAME = 'communication_bindings' THEN
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I WHERE id = $1 AND workspace_id = $2)', CASE row->>'target_type' WHEN 'TASK' THEN 'tasks' ELSE 'calendar_events' END)
   INTO target_valid USING (row->>'target_id')::uuid, (row->>'workspace_id')::uuid;
  IF NOT target_valid THEN RAISE EXCEPTION 'CHAT_MESSAGE_INVALID' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE tab TEXT; BEGIN
 FOREACH tab IN ARRAY ARRAY['chat_message_versions','chat_message_reactions','chat_message_pins','chat_message_favorites','chat_message_reads','chat_read_states','chat_drafts','communication_bindings'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION chat_message_child_guard()', tab || '_guard', tab);
 END LOOP;
END $$;
