-- Channels: subscription publishing spaces with sourced membership, roles, posts and per-post discussions.
CREATE TABLE channels (
 id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
 name TEXT NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 200), description TEXT CHECK(description IS NULL OR length(description) <= 2000),
 visibility TEXT NOT NULL CHECK(visibility IN ('PUBLIC','PRIVATE')), comment_policy TEXT NOT NULL CHECK(comment_policy IN ('MEMBERS','PUBLISHERS','DISABLED')),
 owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, status TEXT NOT NULL CHECK(status IN ('ACTIVE','ARCHIVED')),
 is_deleted BOOLEAN NOT NULL, deleted_at TIMESTAMPTZ, created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 version INTEGER NOT NULL CHECK(version > 0), created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
 UNIQUE(workspace_id, id), CHECK(is_deleted = (deleted_at IS NOT NULL))
);
CREATE TABLE channel_members (
 id UUID PRIMARY KEY, workspace_id UUID NOT NULL, channel_id UUID NOT NULL, user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 role TEXT NOT NULL CHECK(role IN ('OWNER','ADMIN','PUBLISHER','SUBSCRIBER')), joined_at TIMESTAMPTZ NOT NULL, left_at TIMESTAMPTZ,
 UNIQUE(channel_id, user_id), FOREIGN KEY(workspace_id, channel_id) REFERENCES channels(workspace_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE channel_membership_sources (
 id UUID PRIMARY KEY, workspace_id UUID NOT NULL, channel_id UUID NOT NULL, user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
 source_type TEXT NOT NULL CHECK(source_type IN ('MANUAL','DEPARTMENT','PROJECT','SYSTEM')), source_id UUID NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('OWNER','ADMIN','PUBLISHER','SUBSCRIBER')), active BOOLEAN NOT NULL, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
 FOREIGN KEY(workspace_id, channel_id) REFERENCES channels(workspace_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 CHECK((user_id IS NULL) = (source_type IN ('DEPARTMENT','PROJECT'))),
 CHECK(source_type NOT IN ('MANUAL','SYSTEM') OR source_id = channel_id),
 CHECK(role <> 'OWNER' OR source_type = 'MANUAL')
);
CREATE UNIQUE INDEX channel_sources_user ON channel_membership_sources(channel_id, user_id, source_type) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX channel_sources_group ON channel_membership_sources(channel_id, source_type, source_id) WHERE user_id IS NULL;
CREATE TABLE channel_posts (
 id UUID PRIMARY KEY, workspace_id UUID NOT NULL, channel_id UUID NOT NULL, author_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 title TEXT CHECK(title IS NULL OR length(title) <= 300), body TEXT CHECK(body IS NULL OR length(body) <= 20000),
 status TEXT NOT NULL CHECK(status IN ('PUBLISHED','DELETED')), published_at TIMESTAMPTZ NOT NULL, edited_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ,
 deleted_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT, version INTEGER NOT NULL CHECK(version > 0), created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
 UNIQUE(workspace_id, channel_id, id), FOREIGN KEY(workspace_id, channel_id) REFERENCES channels(workspace_id, id) ON DELETE RESTRICT,
 CHECK((status = 'DELETED') = (deleted_at IS NOT NULL) AND (status = 'PUBLISHED') = (body IS NOT NULL) AND (status = 'PUBLISHED' OR title IS NULL))
);
CREATE INDEX channel_posts_channel ON channel_posts(channel_id, published_at DESC);
CREATE TABLE channel_comments (
 id UUID PRIMARY KEY, workspace_id UUID NOT NULL, channel_id UUID NOT NULL, post_id UUID NOT NULL, author_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 body TEXT CHECK(body IS NULL OR length(body) <= 5000), status TEXT NOT NULL CHECK(status IN ('ACTIVE','DELETED')), edited_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ,
 deleted_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT, version INTEGER NOT NULL CHECK(version > 0), created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
 FOREIGN KEY(workspace_id, channel_id, post_id) REFERENCES channel_posts(workspace_id, channel_id, id) ON DELETE RESTRICT,
 CHECK((status = 'DELETED') = (deleted_at IS NOT NULL) AND (status = 'ACTIVE') = (body IS NOT NULL))
);
CREATE INDEX channel_comments_post ON channel_comments(post_id, created_at);

-- Identity, tenant and lifecycle guards.
CREATE FUNCTION channel_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row JSONB; old_row JSONB; channel channels%ROWTYPE; subject UUID; existing BOOLEAN;
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'CHANNEL_HISTORY_IMMUTABLE' USING ERRCODE='23514'; END IF;
 row := to_jsonb(NEW);
 IF TG_OP = 'UPDATE' THEN
  old_row := to_jsonb(OLD);
  IF row->>'workspace_id' <> old_row->>'workspace_id' OR row->>'created_at' IS DISTINCT FROM old_row->>'created_at'
    OR row->>'channel_id' IS DISTINCT FROM old_row->>'channel_id' OR row->>'author_user_id' IS DISTINCT FROM old_row->>'author_user_id'
    OR row->>'created_by_user_id' IS DISTINCT FROM old_row->>'created_by_user_id' OR row->>'published_at' IS DISTINCT FROM old_row->>'published_at'
    OR row->>'post_id' IS DISTINCT FROM old_row->>'post_id' OR (row->>'version')::int < (old_row->>'version')::int
    OR old_row->>'is_deleted' = 'true' AND row->>'is_deleted' = 'false'
    OR old_row->>'status' = 'DELETED' AND row IS DISTINCT FROM old_row THEN
   RAISE EXCEPTION 'CHANNEL_HISTORY_IMMUTABLE' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME IN ('channel_members','channel_membership_sources') AND (row->>'user_id' IS DISTINCT FROM old_row->>'user_id'
    OR row->>'source_type' IS DISTINCT FROM old_row->>'source_type' OR row->>'source_id' IS DISTINCT FROM old_row->>'source_id') THEN
   RAISE EXCEPTION 'CHANNEL_HISTORY_IMMUTABLE' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 -- Prisma upserts run the INSERT trigger for existing rows too; those are governed by the UPDATE branch.
 EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I WHERE id = $1)', TG_TABLE_NAME) INTO existing USING (row->>'id')::uuid;
 IF existing THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME = 'channels' THEN subject := (row->>'owner_user_id')::uuid;
 ELSE
  SELECT * INTO channel FROM channels WHERE id = (row->>'channel_id')::uuid AND workspace_id = (row->>'workspace_id')::uuid;
  IF TG_TABLE_NAME IN ('channel_posts','channel_comments') AND (NOT FOUND OR channel.status <> 'ACTIVE' OR channel.is_deleted) THEN
   RAISE EXCEPTION 'CHANNEL_ARCHIVED' USING ERRCODE='23514';
  END IF;
  subject := (row->>CASE WHEN TG_TABLE_NAME IN ('channel_posts','channel_comments') THEN 'author_user_id' ELSE 'user_id' END)::uuid;
 END IF;
 IF TG_TABLE_NAME = 'channel_comments' AND NOT EXISTS(SELECT 1 FROM channel_posts p WHERE p.id = (row->>'post_id')::uuid AND p.status = 'PUBLISHED') THEN
  RAISE EXCEPTION 'CHANNEL_HISTORY_IMMUTABLE' USING ERRCODE='23514';
 END IF;
 IF TG_TABLE_NAME = 'channel_membership_sources' AND subject IS NULL THEN
  IF row->>'source_type' = 'DEPARTMENT' AND NOT EXISTS(SELECT 1 FROM departments WHERE id = (row->>'source_id')::uuid AND workspace_id = (row->>'workspace_id')::uuid)
    OR row->>'source_type' = 'PROJECT' AND NOT EXISTS(SELECT 1 FROM projects WHERE id = (row->>'source_id')::uuid AND workspace_id = (row->>'workspace_id')::uuid) THEN
   RAISE EXCEPTION 'CHANNEL_MEMBER_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 -- External identities never join ordinary Channels: every new user row needs an active internal Workspace membership.
 IF NOT EXISTS(SELECT 1 FROM workspace_memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = (row->>'workspace_id')::uuid AND m.user_id = subject
   AND m.status = 'ACTIVE' AND NOT m.is_deleted AND u.status = 'ACTIVE' AND NOT u.is_deleted) THEN
  RAISE EXCEPTION 'CHANNEL_MEMBER_INVALID' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE tab TEXT; BEGIN
 FOREACH tab IN ARRAY ARRAY['channels','channel_members','channel_membership_sources','channel_posts','channel_comments'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION channel_guard()', tab || '_guard', tab);
 END LOOP;
END $$;

-- Exactly one owner: the Channel owner holds the only current OWNER assignment and an active direct grant.
CREATE FUNCTION channel_owner_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target UUID;
BEGIN
 target := CASE TG_TABLE_NAME WHEN 'channels' THEN (to_jsonb(NEW)->>'id')::uuid ELSE (to_jsonb(NEW)->>'channel_id')::uuid END;
 IF EXISTS(SELECT 1 FROM channels c WHERE c.id = target AND NOT c.is_deleted AND (
   NOT EXISTS(SELECT 1 FROM channel_membership_sources s WHERE s.channel_id = c.id AND s.user_id = c.owner_user_id AND s.source_type = 'MANUAL' AND s.active)
   OR (SELECT count(*) FROM channel_members m WHERE m.channel_id = c.id AND m.role = 'OWNER' AND m.left_at IS NULL) <> 1
   OR NOT EXISTS(SELECT 1 FROM channel_members m WHERE m.channel_id = c.id AND m.user_id = c.owner_user_id AND m.role = 'OWNER' AND m.left_at IS NULL))) THEN
  RAISE EXCEPTION 'CHANNEL_OWNER_REQUIRED' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER channel_owner_guard AFTER INSERT OR UPDATE ON channels DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION channel_owner_guard();
CREATE CONSTRAINT TRIGGER channel_member_owner_guard AFTER INSERT OR UPDATE ON channel_members DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION channel_owner_guard();
CREATE CONSTRAINT TRIGGER channel_source_owner_guard AFTER INSERT OR UPDATE ON channel_membership_sources DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION channel_owner_guard();
