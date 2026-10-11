-- Feed: recipient-based posts, announcement audience snapshots, engagement and polls.
CREATE TABLE feed_posts (
 id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT, author_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 post_type TEXT NOT NULL CHECK(post_type IN ('STANDARD','ANNOUNCEMENT','APPRECIATION','POLL')), title TEXT CHECK(title IS NULL OR length(title) <= 300),
 body TEXT NOT NULL CHECK(length(body) <= 20000), status TEXT NOT NULL CHECK(status IN ('DRAFT','PUBLISHED','DELETED')),
 status_before_delete TEXT CHECK(status_before_delete IS NULL OR status_before_delete IN ('DRAFT','PUBLISHED')), requires_acknowledgement BOOLEAN NOT NULL,
 mention_user_ids UUID[] NOT NULL CHECK(cardinality(mention_user_ids) <= 50), is_pinned BOOLEAN NOT NULL, published_at TIMESTAMPTZ, edited_at TIMESTAMPTZ,
 deleted_at TIMESTAMPTZ, deleted_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT, version INTEGER NOT NULL CHECK(version > 0),
 created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL, UNIQUE(workspace_id, id),
 CHECK((status = 'DELETED') = (deleted_at IS NOT NULL) AND (status = 'DELETED') = (status_before_delete IS NOT NULL)),
 CHECK(status <> 'PUBLISHED' OR published_at IS NOT NULL), CHECK(NOT requires_acknowledgement OR post_type = 'ANNOUNCEMENT'),
 CHECK(NOT is_pinned OR status = 'PUBLISHED')
);
CREATE INDEX feed_posts_published ON feed_posts(workspace_id, published_at DESC) WHERE status = 'PUBLISHED';
CREATE TABLE feed_post_recipients (
 id UUID PRIMARY KEY, workspace_id UUID NOT NULL, post_id UUID NOT NULL, recipient_type TEXT NOT NULL CHECK(recipient_type IN ('WORKSPACE','USER','DEPARTMENT','PROJECT')),
 recipient_id UUID, FOREIGN KEY(workspace_id, post_id) REFERENCES feed_posts(workspace_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 CHECK((recipient_type = 'WORKSPACE') = (recipient_id IS NULL))
);
CREATE UNIQUE INDEX feed_post_recipients_unique ON feed_post_recipients(post_id, recipient_type, COALESCE(recipient_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE TABLE feed_post_audience_snapshots (
 id UUID PRIMARY KEY, workspace_id UUID NOT NULL, post_id UUID NOT NULL, user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 reason TEXT NOT NULL CHECK(length(reason) <= 50), published_at TIMESTAMPTZ NOT NULL, UNIQUE(post_id, user_id),
 FOREIGN KEY(workspace_id, post_id) REFERENCES feed_posts(workspace_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE feed_comments (
 id UUID PRIMARY KEY, workspace_id UUID NOT NULL, post_id UUID NOT NULL, author_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 body TEXT CHECK(body IS NULL OR length(body) <= 5000), status TEXT NOT NULL CHECK(status IN ('ACTIVE','DELETED')), edited_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ,
 deleted_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT, version INTEGER NOT NULL CHECK(version > 0), created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
 FOREIGN KEY(workspace_id, post_id) REFERENCES feed_posts(workspace_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 CHECK((status = 'DELETED') = (deleted_at IS NOT NULL) AND (status = 'ACTIVE') = (body IS NOT NULL))
);
CREATE TABLE feed_reactions (
 id UUID PRIMARY KEY, workspace_id UUID NOT NULL, post_id UUID NOT NULL, user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 reaction TEXT NOT NULL CHECK(length(reaction) BETWEEN 1 AND 64), created_at TIMESTAMPTZ NOT NULL, UNIQUE(post_id, user_id, reaction),
 FOREIGN KEY(workspace_id, post_id) REFERENCES feed_posts(workspace_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE feed_favorites (
 id UUID PRIMARY KEY, workspace_id UUID NOT NULL, post_id UUID NOT NULL, user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, created_at TIMESTAMPTZ NOT NULL,
 UNIQUE(post_id, user_id), FOREIGN KEY(workspace_id, post_id) REFERENCES feed_posts(workspace_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE feed_post_reads (
 id UUID PRIMARY KEY, workspace_id UUID NOT NULL, post_id UUID NOT NULL, user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, read_at TIMESTAMPTZ NOT NULL,
 UNIQUE(post_id, user_id), FOREIGN KEY(workspace_id, post_id) REFERENCES feed_posts(workspace_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE feed_announcement_acknowledgements (
 id UUID PRIMARY KEY, workspace_id UUID NOT NULL, post_id UUID NOT NULL, user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, acknowledged_at TIMESTAMPTZ NOT NULL,
 UNIQUE(post_id, user_id), FOREIGN KEY(workspace_id, post_id) REFERENCES feed_posts(workspace_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE polls (
 id UUID PRIMARY KEY, workspace_id UUID NOT NULL, post_id UUID NOT NULL UNIQUE, question TEXT NOT NULL CHECK(length(btrim(question)) BETWEEN 1 AND 500),
 is_anonymous BOOLEAN NOT NULL, allow_multiple BOOLEAN NOT NULL, closes_at TIMESTAMPTZ, created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 created_at TIMESTAMPTZ NOT NULL, UNIQUE(workspace_id, id),
 FOREIGN KEY(workspace_id, post_id) REFERENCES feed_posts(workspace_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE poll_options (
 id UUID PRIMARY KEY, workspace_id UUID NOT NULL, poll_id UUID NOT NULL, label TEXT NOT NULL CHECK(length(btrim(label)) BETWEEN 1 AND 200),
 position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 19), UNIQUE(poll_id, position), UNIQUE(workspace_id, poll_id, id),
 FOREIGN KEY(workspace_id, poll_id) REFERENCES polls(workspace_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE poll_votes (
 id UUID PRIMARY KEY, workspace_id UUID NOT NULL, poll_id UUID NOT NULL, option_id UUID NOT NULL, user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 created_at TIMESTAMPTZ NOT NULL, UNIQUE(poll_id, user_id, option_id),
 FOREIGN KEY(workspace_id, poll_id, option_id) REFERENCES poll_options(workspace_id, poll_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);

CREATE FUNCTION feed_post_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN
  -- Only a soft-deleted post can be permanently removed (moderator hard delete).
  IF OLD.status <> 'DELETED' THEN RAISE EXCEPTION 'FEED_HISTORY_IMMUTABLE' USING ERRCODE='23514'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP = 'INSERT' AND NOT EXISTS(SELECT 1 FROM feed_posts WHERE id = NEW.id) THEN
  IF NOT EXISTS(SELECT 1 FROM workspace_memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = NEW.workspace_id AND m.user_id = NEW.author_user_id
    AND m.status = 'ACTIVE' AND NOT m.is_deleted AND NOT u.is_deleted) THEN RAISE EXCEPTION 'FEED_AUDIENCE_NOT_ALLOWED' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP = 'UPDATE' AND (NEW.workspace_id <> OLD.workspace_id OR NEW.author_user_id <> OLD.author_user_id OR NEW.post_type <> OLD.post_type OR NEW.created_at <> OLD.created_at
   OR NEW.version < OLD.version OR OLD.published_at IS NOT NULL AND NEW.published_at IS DISTINCT FROM OLD.published_at
   OR OLD.status = 'PUBLISHED' AND NEW.status = 'DRAFT' OR NEW.requires_acknowledgement <> OLD.requires_acknowledgement AND OLD.status <> 'DRAFT') THEN
  RAISE EXCEPTION 'FEED_HISTORY_IMMUTABLE' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER feed_post_guard BEFORE INSERT OR UPDATE OR DELETE ON feed_posts FOR EACH ROW EXECUTE FUNCTION feed_post_guard();

-- Dependent rows: tenant users on insert; audience/receipt history only changes with a draft edit or a moderator hard delete.
CREATE FUNCTION feed_child_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row JSONB; post feed_posts%ROWTYPE; poll polls%ROWTYPE; subject UUID; existing BOOLEAN;
BEGIN
 row := to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END);
 IF TG_TABLE_NAME IN ('poll_options','poll_votes') THEN
  SELECT * INTO poll FROM polls WHERE id = (row->>'poll_id')::uuid;
  SELECT * INTO post FROM feed_posts WHERE id = poll.post_id;
 ELSE
  SELECT * INTO post FROM feed_posts WHERE id = (row->>'post_id')::uuid;
 END IF;
 IF TG_OP = 'DELETE' THEN
  IF post.status = 'DELETED' OR NOT FOUND THEN RETURN OLD; END IF;
  IF TG_TABLE_NAME = 'feed_post_recipients' AND post.status = 'DRAFT' OR TG_TABLE_NAME IN ('feed_reactions','feed_favorites') THEN RETURN OLD; END IF;
  IF TG_TABLE_NAME = 'poll_votes' AND (poll.closes_at IS NULL OR poll.closes_at > CURRENT_TIMESTAMP) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'FEED_HISTORY_IMMUTABLE' USING ERRCODE='23514';
 END IF;
 IF TG_OP = 'UPDATE' THEN
  IF TG_TABLE_NAME = 'feed_comments' THEN
   IF row->>'post_id' <> to_jsonb(OLD)->>'post_id' OR row->>'author_user_id' <> to_jsonb(OLD)->>'author_user_id' OR to_jsonb(OLD)->>'status' = 'DELETED' AND row IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'FEED_HISTORY_IMMUTABLE' USING ERRCODE='23514';
   END IF;
   RETURN NEW;
  END IF;
  IF row IS DISTINCT FROM to_jsonb(OLD) THEN RAISE EXCEPTION 'FEED_HISTORY_IMMUTABLE' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I WHERE id = $1)', TG_TABLE_NAME) INTO existing USING (row->>'id')::uuid;
 IF existing THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME = 'feed_post_audience_snapshots' AND (post.post_type <> 'ANNOUNCEMENT' OR post.status <> 'PUBLISHED') THEN RAISE EXCEPTION 'FEED_HISTORY_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME = 'feed_announcement_acknowledgements' AND (NOT post.requires_acknowledgement OR post.status <> 'PUBLISHED' OR NOT EXISTS(SELECT 1 FROM feed_post_audience_snapshots s
   WHERE s.post_id = post.id AND s.user_id = (row->>'user_id')::uuid)) THEN RAISE EXCEPTION 'FEED_ACK_NOT_REQUIRED' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME = 'poll_votes' AND (post.status <> 'PUBLISHED' OR poll.closes_at IS NOT NULL AND poll.closes_at <= CURRENT_TIMESTAMP
   OR NOT poll.allow_multiple AND EXISTS(SELECT 1 FROM poll_votes v WHERE v.poll_id = poll.id AND v.user_id = (row->>'user_id')::uuid)) THEN
  RAISE EXCEPTION 'POLL_NOT_OPEN' USING ERRCODE='23514';
 END IF;
 IF TG_TABLE_NAME = 'poll_options' AND EXISTS(SELECT 1 FROM poll_votes v WHERE v.poll_id = poll.id) THEN RAISE EXCEPTION 'FEED_HISTORY_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME = 'feed_post_recipients' THEN
  IF row->>'recipient_type' = 'USER' AND NOT EXISTS(SELECT 1 FROM workspace_memberships m WHERE m.workspace_id = (row->>'workspace_id')::uuid AND m.user_id = (row->>'recipient_id')::uuid)
    OR row->>'recipient_type' = 'DEPARTMENT' AND NOT EXISTS(SELECT 1 FROM departments d WHERE d.id = (row->>'recipient_id')::uuid AND d.workspace_id = (row->>'workspace_id')::uuid)
    OR row->>'recipient_type' = 'PROJECT' AND NOT EXISTS(SELECT 1 FROM projects p WHERE p.id = (row->>'recipient_id')::uuid AND p.workspace_id = (row->>'workspace_id')::uuid) THEN
   RAISE EXCEPTION 'FEED_AUDIENCE_NOT_ALLOWED' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 subject := (row->>CASE TG_TABLE_NAME WHEN 'feed_comments' THEN 'author_user_id' WHEN 'polls' THEN 'created_by_user_id' ELSE 'user_id' END)::uuid;
 IF subject IS NOT NULL AND NOT EXISTS(SELECT 1 FROM workspace_memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = (row->>'workspace_id')::uuid
   AND m.user_id = subject AND m.status = 'ACTIVE' AND NOT m.is_deleted AND NOT u.is_deleted) THEN
  RAISE EXCEPTION 'FEED_AUDIENCE_NOT_ALLOWED' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE tab TEXT; BEGIN
 FOREACH tab IN ARRAY ARRAY['feed_post_recipients','feed_post_audience_snapshots','feed_comments','feed_reactions','feed_favorites','feed_post_reads',
   'feed_announcement_acknowledgements','polls','poll_options','poll_votes'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION feed_child_guard()', tab || '_guard', tab);
 END LOOP;
END $$;
