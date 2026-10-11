-- Internal calls: durable lifecycle state, participants and call-scoped external guest access.
CREATE TABLE communication_calls (
 id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT, chat_id UUID, collab_id UUID,
 call_type TEXT NOT NULL CHECK(call_type IN ('AUDIO','VIDEO')), title TEXT CHECK(title IS NULL OR length(title) <= 200),
 started_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 status TEXT NOT NULL CHECK(status IN ('RINGING','ACTIVE','ENDED','FAILED','CANCELLED')), provider TEXT NOT NULL CHECK(length(provider) BETWEEN 1 AND 50),
 provider_room_id TEXT CHECK(provider_room_id IS NULL OR provider_room_id ~ '^[A-Za-z0-9._:-]{1,200}$'), error_code TEXT CHECK(error_code IS NULL OR length(error_code) <= 100),
 recording_enabled BOOLEAN NOT NULL, recording_file_id UUID, invitee_user_ids UUID[] NOT NULL CHECK(cardinality(invitee_user_ids) <= 1000),
 idempotency_key TEXT CHECK(idempotency_key IS NULL OR length(idempotency_key) <= 200), started_at TIMESTAMPTZ NOT NULL, ended_at TIMESTAMPTZ,
 ended_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT, version INTEGER NOT NULL CHECK(version > 0), created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
 UNIQUE(workspace_id, id),
 FOREIGN KEY(workspace_id, chat_id) REFERENCES collaboration_chats(workspace_id, id) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id, collab_id) REFERENCES collab_spaces(workspace_id, id) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id, recording_file_id) REFERENCES drive_files(workspace_id, id) ON DELETE RESTRICT,
 CHECK(chat_id IS NULL OR collab_id IS NULL),
 CHECK((status IN ('ENDED','FAILED','CANCELLED')) = (ended_at IS NOT NULL)),
 CHECK(status <> 'FAILED' OR error_code IS NOT NULL AND provider_room_id IS NULL),
 CHECK(status <> 'ACTIVE' OR provider_room_id IS NOT NULL),
 CHECK(recording_file_id IS NULL OR recording_enabled AND status = 'ENDED')
);
CREATE INDEX communication_calls_context ON communication_calls(workspace_id, started_at DESC);
CREATE TABLE communication_call_invitations (
 id UUID PRIMARY KEY, workspace_id UUID NOT NULL, call_id UUID NOT NULL, display_name TEXT NOT NULL CHECK(length(btrim(display_name)) BETWEEN 1 AND 100),
 email TEXT CHECK(email IS NULL OR email = lower(email)), token_hash TEXT NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 expires_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ, created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, created_at TIMESTAMPTZ NOT NULL,
 UNIQUE(workspace_id, call_id, id), FOREIGN KEY(workspace_id, call_id) REFERENCES communication_calls(workspace_id, id) ON DELETE RESTRICT,
 CHECK(expires_at > created_at AND expires_at <= created_at + interval '24 hours')
);
CREATE TABLE communication_call_participants (
 id UUID PRIMARY KEY, workspace_id UUID NOT NULL, call_id UUID NOT NULL, user_id UUID REFERENCES users(id) ON DELETE RESTRICT, external_guest_id UUID,
 display_name TEXT CHECK(display_name IS NULL OR length(display_name) <= 100), role TEXT NOT NULL CHECK(role IN ('HOST','PARTICIPANT','GUEST')),
 status TEXT NOT NULL CHECK(status IN ('INVITED','JOINED','LEFT')), joined_at TIMESTAMPTZ, left_at TIMESTAMPTZ,
 FOREIGN KEY(workspace_id, call_id) REFERENCES communication_calls(workspace_id, id) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id, call_id, external_guest_id) REFERENCES communication_call_invitations(workspace_id, call_id, id) ON DELETE RESTRICT,
 CHECK(num_nonnulls(user_id, external_guest_id) = 1), CHECK((role = 'GUEST') = (external_guest_id IS NOT NULL)),
 CHECK(status <> 'JOINED' OR joined_at IS NOT NULL AND left_at IS NULL), CHECK(status <> 'LEFT' OR left_at IS NOT NULL)
);
CREATE UNIQUE INDEX communication_call_participant_user ON communication_call_participants(call_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX communication_call_participant_guest ON communication_call_participants(call_id, external_guest_id) WHERE external_guest_id IS NOT NULL;

-- One-way lifecycle and immutable identity; terminal calls accept no new participants or guest links.
CREATE FUNCTION communication_call_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row JSONB; old_row JSONB; call communication_calls%ROWTYPE; existing BOOLEAN;
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'CALL_HISTORY_IMMUTABLE' USING ERRCODE='23514'; END IF;
 row := to_jsonb(NEW);
 IF TG_OP = 'UPDATE' THEN
  old_row := to_jsonb(OLD);
  IF TG_TABLE_NAME = 'communication_calls' THEN
  IF (NEW.workspace_id <> OLD.workspace_id OR NEW.chat_id IS DISTINCT FROM OLD.chat_id OR NEW.collab_id IS DISTINCT FROM OLD.collab_id
    OR NEW.started_by_user_id <> OLD.started_by_user_id OR NEW.call_type <> OLD.call_type OR NEW.started_at <> OLD.started_at OR NEW.version < OLD.version
    OR OLD.provider_room_id IS NOT NULL AND NEW.provider_room_id IS DISTINCT FROM OLD.provider_room_id
    OR OLD.recording_file_id IS NOT NULL AND NEW.recording_file_id IS DISTINCT FROM OLD.recording_file_id
    OR OLD.status IN ('FAILED','CANCELLED') AND NEW IS DISTINCT FROM OLD
    OR OLD.status = 'ENDED' AND (NEW.status <> 'ENDED' OR NEW.ended_at <> OLD.ended_at)
    OR OLD.status = 'ACTIVE' AND NEW.status NOT IN ('ACTIVE','ENDED')) THEN
   RAISE EXCEPTION 'CALL_INVALID_STATE' USING ERRCODE='23514';
  END IF;
  END IF;
  IF TG_TABLE_NAME = 'communication_call_invitations' AND (old_row - 'revoked_at' IS DISTINCT FROM row - 'revoked_at' OR old_row->>'revoked_at' IS NOT NULL AND row IS DISTINCT FROM old_row) THEN
   RAISE EXCEPTION 'CALL_EXTERNAL_TOKEN_INVALID' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME = 'communication_call_participants' AND (row->>'call_id' <> old_row->>'call_id' OR row->>'user_id' IS DISTINCT FROM old_row->>'user_id'
    OR row->>'external_guest_id' IS DISTINCT FROM old_row->>'external_guest_id' OR row->>'role' <> old_row->>'role') THEN
   RAISE EXCEPTION 'CALL_INVALID_STATE' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I WHERE id = $1)', TG_TABLE_NAME) INTO existing USING (row->>'id')::uuid;
 IF existing THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME = 'communication_calls' THEN
  IF row->>'status' <> 'RINGING' OR row->>'provider_room_id' IS NOT NULL OR NOT EXISTS(SELECT 1 FROM workspace_memberships m JOIN users u ON u.id = m.user_id
    WHERE m.workspace_id = (row->>'workspace_id')::uuid AND m.user_id = (row->>'started_by_user_id')::uuid AND m.status = 'ACTIVE' AND NOT m.is_deleted AND NOT u.is_deleted) THEN
   RAISE EXCEPTION 'CALL_ACCESS_DENIED' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO call FROM communication_calls WHERE id = (row->>'call_id')::uuid AND workspace_id = (row->>'workspace_id')::uuid;
 IF NOT FOUND OR call.status NOT IN ('RINGING','ACTIVE') OR call.provider_room_id IS NULL THEN RAISE EXCEPTION 'CALL_INVALID_STATE' USING ERRCODE='23514'; END IF;
 -- Internal participants are active Workspace members or active members of the call's Collab; guests come only from a call link.
 IF TG_TABLE_NAME = 'communication_call_participants' AND row->>'user_id' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM workspace_memberships m
   WHERE m.workspace_id = call.workspace_id AND m.user_id = (row->>'user_id')::uuid AND m.status = 'ACTIVE' AND NOT m.is_deleted)
   AND NOT (call.collab_id IS NOT NULL AND EXISTS(SELECT 1 FROM collab_space_members c WHERE c.collab_id = call.collab_id AND c.user_id = (row->>'user_id')::uuid AND c.status = 'ACTIVE')) THEN
  RAISE EXCEPTION 'CALL_ACCESS_DENIED' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE tab TEXT; BEGIN
 FOREACH tab IN ARRAY ARRAY['communication_calls','communication_call_invitations','communication_call_participants'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION communication_call_guard()', tab || '_guard', tab);
 END LOOP;
END $$;
