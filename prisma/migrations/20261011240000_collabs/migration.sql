-- Collab metadata and hashed, single-use external invitations.
ALTER TABLE collab_spaces ADD COLUMN description TEXT CHECK(description IS NULL OR length(description) <= 2000),
 ADD COLUMN created_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT, ADD COLUMN archived_at TIMESTAMPTZ,
 ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE collab_spaces ADD CHECK(length(btrim(name)) BETWEEN 1 AND 200);
CREATE FUNCTION collab_space_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'COLLAB_HISTORY_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF NEW.workspace_id <> OLD.workspace_id OR NEW.created_at <> OLD.created_at OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id OR NEW.version < OLD.version THEN
  RAISE EXCEPTION 'COLLAB_HISTORY_IMMUTABLE' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER collab_space_identity_guard BEFORE UPDATE OR DELETE ON collab_spaces FOR EACH ROW EXECUTE FUNCTION collab_space_identity_guard();
-- The owner keeps an ACTIVE OWNER membership; removed members cannot hold roles that imply authority.
CREATE FUNCTION collab_owner_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target UUID;
BEGIN
 target := CASE TG_TABLE_NAME WHEN 'collab_spaces' THEN (to_jsonb(NEW)->>'id')::uuid ELSE (to_jsonb(NEW)->>'collab_id')::uuid END;
 IF EXISTS(SELECT 1 FROM collab_spaces c WHERE c.id = target AND c.created_by_user_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM collab_space_members m
   WHERE m.collab_id = c.id AND m.user_id = c.owner_user_id AND m.role = 'OWNER' AND m.status = 'ACTIVE' AND m.left_at IS NULL)) THEN
  RAISE EXCEPTION 'COLLAB_OWNER_REQUIRED' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER collab_owner_guard AFTER INSERT OR UPDATE ON collab_spaces DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION collab_owner_guard();
CREATE CONSTRAINT TRIGGER collab_member_owner_guard AFTER INSERT OR UPDATE ON collab_space_members DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION collab_owner_guard();
ALTER TABLE collab_space_members ADD CHECK(status <> 'REMOVED' OR left_at IS NOT NULL);
ALTER TABLE collab_space_members ADD CHECK(member_type = 'INTERNAL' OR role IN ('MEMBER','GUEST'));

CREATE TABLE collab_invitations (
 id UUID PRIMARY KEY, workspace_id UUID NOT NULL, collab_id UUID NOT NULL,
 email TEXT NOT NULL CHECK(email = lower(email) AND length(email) BETWEEN 3 AND 320 AND position('@' in email) > 1),
 role TEXT NOT NULL CHECK(role IN ('MEMBER','GUEST')), token_hash TEXT NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 expires_at TIMESTAMPTZ NOT NULL, accepted_at TIMESTAMPTZ, accepted_user_id UUID REFERENCES users(id) ON DELETE RESTRICT, revoked_at TIMESTAMPTZ,
 invited_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, send_count INTEGER NOT NULL CHECK(send_count > 0),
 version INTEGER NOT NULL CHECK(version > 0), created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
 FOREIGN KEY(workspace_id, collab_id) REFERENCES collab_spaces(workspace_id, id) ON DELETE RESTRICT,
 CHECK((accepted_at IS NULL) = (accepted_user_id IS NULL)), CHECK(accepted_at IS NULL OR revoked_at IS NULL),
 CHECK(expires_at > created_at AND expires_at <= updated_at + interval '90 days 1 minute')
);
CREATE UNIQUE INDEX collab_invitations_pending ON collab_invitations(collab_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE FUNCTION collab_invitation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'COLLAB_INVITATION_INVALID' USING ERRCODE='23514'; END IF;
 IF TG_OP = 'INSERT' AND NOT EXISTS(SELECT 1 FROM collab_invitations WHERE id = NEW.id) THEN
  IF NEW.accepted_at IS NOT NULL OR NEW.revoked_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM collab_spaces c WHERE c.id = NEW.collab_id AND c.status = 'ACTIVE')
    OR NOT EXISTS(SELECT 1 FROM workspace_memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = NEW.workspace_id AND m.user_id = NEW.invited_by_user_id
      AND m.status = 'ACTIVE' AND NOT m.is_deleted AND NOT u.is_deleted) THEN
   RAISE EXCEPTION 'COLLAB_INVITATION_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 IF TG_OP = 'UPDATE' AND (NEW.workspace_id <> OLD.workspace_id OR NEW.collab_id <> OLD.collab_id OR NEW.email <> OLD.email OR NEW.invited_by_user_id <> OLD.invited_by_user_id
   OR NEW.created_at <> OLD.created_at OR NEW.send_count < OLD.send_count OR NEW.version < OLD.version
   OR (OLD.accepted_at IS NOT NULL OR OLD.revoked_at IS NOT NULL) AND NEW IS DISTINCT FROM OLD
   OR NEW.token_hash <> OLD.token_hash AND NEW.send_count <= OLD.send_count) THEN
  RAISE EXCEPTION 'COLLAB_INVITATION_INVALID' USING ERRCODE='23514';
 END IF;
 -- Acceptance is single-use and creates exactly the invited membership.
 IF TG_OP = 'UPDATE' AND NEW.accepted_at IS NOT NULL AND OLD.accepted_at IS NULL AND (OLD.expires_at <= NEW.accepted_at OR NOT EXISTS(SELECT 1 FROM users u
   WHERE u.id = NEW.accepted_user_id AND lower(u.email) = NEW.email AND NOT u.is_deleted)) THEN
  RAISE EXCEPTION 'COLLAB_INVITATION_INVALID' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER collab_invitation_guard BEFORE INSERT OR UPDATE OR DELETE ON collab_invitations FOR EACH ROW EXECUTE FUNCTION collab_invitation_guard();
