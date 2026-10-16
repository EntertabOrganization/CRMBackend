-- CreateTable
CREATE TABLE "knowledge_spaces" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "owner_user_id" UUID NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'PRIVATE',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "status_before_recycle" TEXT,
    "ai_indexing" BOOLEAN NOT NULL DEFAULT false,
    "content_classification" TEXT NOT NULL DEFAULT 'INTERNAL',
    "ai_policy_approved_by" UUID,
    "ai_policy_approved_at" TIMESTAMPTZ(6),
    "acl_version" INTEGER NOT NULL DEFAULT 1,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_spaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_space_bindings" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "knowledge_space_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_articles" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "parent_article_id" UUID,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "owner_user_id" UUID NOT NULL,
    "current_draft_revision_id" UUID,
    "published_revision_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "status_before_recycle" TEXT,
    "status_before_archive" TEXT,
    "acl_version" INTEGER NOT NULL DEFAULT 1,
    "version" INTEGER NOT NULL DEFAULT 1,
    "review_due_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(6),

    CONSTRAINT "knowledge_articles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_article_paths" (
    "ancestor_id" UUID NOT NULL,
    "descendant_id" UUID NOT NULL,
    "depth" INTEGER NOT NULL,

    CONSTRAINT "knowledge_article_paths_pkey" PRIMARY KEY ("ancestor_id","descendant_id")
);

-- CreateTable
CREATE TABLE "knowledge_revisions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "article_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "content_json" JSONB NOT NULL,
    "content_hash" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'DRAFT',
    "author_user_id" UUID NOT NULL,
    "source_revision_id" UUID,
    "idempotency_key" TEXT,
    "safety_scan" TEXT NOT NULL DEFAULT 'PASSED',
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_sections" (
    "id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "anchor" TEXT NOT NULL,
    "heading_level" INTEGER NOT NULL,
    "order" INTEGER NOT NULL,
    "title" TEXT NOT NULL,

    CONSTRAINT "knowledge_sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_edit_sessions" (
    "id" UUID NOT NULL,
    "article_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "baseline_revision_id" UUID,
    "conflict_state" TEXT,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_edit_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_file_bindings" (
    "id" UUID NOT NULL,
    "article_id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "usage_kind" TEXT NOT NULL,

    CONSTRAINT "knowledge_file_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_acl_entries" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" UUID NOT NULL,
    "principal_type" TEXT NOT NULL,
    "principal_id" UUID NOT NULL,
    "level" TEXT NOT NULL,
    "effect" TEXT NOT NULL DEFAULT 'ALLOW',
    "issued_by" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_acl_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_guest_invitations" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "article_id" UUID NOT NULL,
    "email_hash" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "invited_by" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "accepted_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_guest_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_shares" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "article_id" UUID NOT NULL,
    "shared_with_user_id" UUID NOT NULL,
    "level" TEXT NOT NULL,
    "granted_by" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_shares_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_review_policies" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "required_reviewers" INTEGER NOT NULL DEFAULT 1,
    "review_interval_days" INTEGER,
    "two_person_rule" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "knowledge_review_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_publication_requests" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "article_id" UUID NOT NULL,
    "draft_revision_id" UUID NOT NULL,
    "content_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requestor_id" UUID NOT NULL,
    "reviewer_id" UUID,
    "decision_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ(6),

    CONSTRAINT "knowledge_publication_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_ack_requirements" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "article_id" UUID NOT NULL,
    "published_revision_id" UUID NOT NULL,
    "audience_scope" JSONB NOT NULL,
    "due_at" TIMESTAMPTZ(6),
    "renewal_policy" TEXT NOT NULL DEFAULT 'EACH_PUBLISHED_REVISION',
    "restricted" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_ack_requirements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_acknowledgments" (
    "id" UUID NOT NULL,
    "requirement_id" UUID NOT NULL,
    "employee_user_id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "acknowledged_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_acknowledgments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_ai_chunks" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "article_id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "chunk_number" INTEGER NOT NULL,
    "anchor" TEXT,
    "content" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "classification" TEXT NOT NULL,
    "embedding_ref" TEXT,
    "indexing_status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "indexed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_ai_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_import_jobs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "requested_by" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "format" TEXT NOT NULL,
    "target_space_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UPLOADED',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "cursor" INTEGER NOT NULL DEFAULT 0,
    "idempotency_key" TEXT,
    "preview" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_import_rows" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "source_path" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" JSONB,
    "target_article_id" UUID,
    "outcome" TEXT NOT NULL DEFAULT 'PENDING',
    "validation_errors" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "knowledge_import_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_templates" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "content_schema" JSONB NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'WORKSPACE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_export_jobs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "requester_id" UUID NOT NULL,
    "scope_hash" TEXT NOT NULL,
    "request" JSONB NOT NULL,
    "format" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "article_ids" JSONB NOT NULL DEFAULT '[]',
    "output_sealed" TEXT,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_export_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_lifecycle_events" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "article_id" UUID NOT NULL,
    "prior_status" TEXT NOT NULL,
    "next_status" TEXT NOT NULL,
    "actor_id" UUID NOT NULL,
    "reason" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_lifecycle_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_tombstones" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "article_id" UUID NOT NULL,
    "original_space_id" UUID NOT NULL,
    "original_parent_id" UUID,
    "deleted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recover_until" TIMESTAMPTZ(6) NOT NULL,
    "legal_hold" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "knowledge_tombstones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_retention_assignments" (
    "id" UUID NOT NULL,
    "resource_id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "policy_id" UUID NOT NULL,

    CONSTRAINT "knowledge_retention_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_user_favorites" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "article_id" UUID NOT NULL,
    "favorited_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_user_favorites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_read_events" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "article_id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "reader_id" UUID NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_read_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_review_assignments" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "article_id" UUID NOT NULL,
    "reviewer_user_id" UUID NOT NULL,
    "due_at" TIMESTAMPTZ(6) NOT NULL,
    "current_state" TEXT NOT NULL DEFAULT 'OPEN',
    "escalated_at" TIMESTAMPTZ(6),

    CONSTRAINT "knowledge_review_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "knowledge_spaces_workspace_id_status_idx" ON "knowledge_spaces"("workspace_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_spaces_workspace_id_slug_key" ON "knowledge_spaces"("workspace_id", "slug");

-- CreateIndex
CREATE INDEX "knowledge_space_bindings_workspace_id_space_id_idx" ON "knowledge_space_bindings"("workspace_id", "space_id");

-- CreateIndex
CREATE INDEX "knowledge_articles_workspace_id_space_id_parent_article_id_idx" ON "knowledge_articles"("workspace_id", "space_id", "parent_article_id");

-- CreateIndex
CREATE INDEX "knowledge_articles_workspace_id_status_idx" ON "knowledge_articles"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "knowledge_article_paths_descendant_id_idx" ON "knowledge_article_paths"("descendant_id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_revisions_article_id_version_number_key" ON "knowledge_revisions"("article_id", "version_number");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_revisions_article_id_idempotency_key_key" ON "knowledge_revisions"("article_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_sections_revision_id_anchor_key" ON "knowledge_sections"("revision_id", "anchor");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_edit_sessions_article_id_user_id_key" ON "knowledge_edit_sessions"("article_id", "user_id");

-- CreateIndex
CREATE INDEX "knowledge_file_bindings_article_id_idx" ON "knowledge_file_bindings"("article_id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_file_bindings_revision_id_file_id_usage_kind_key" ON "knowledge_file_bindings"("revision_id", "file_id", "usage_kind");

-- CreateIndex
CREATE INDEX "knowledge_acl_entries_workspace_id_resource_type_resource_i_idx" ON "knowledge_acl_entries"("workspace_id", "resource_type", "resource_id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_guest_invitations_token_hash_key" ON "knowledge_guest_invitations"("token_hash");

-- CreateIndex
CREATE INDEX "knowledge_guest_invitations_workspace_id_article_id_idx" ON "knowledge_guest_invitations"("workspace_id", "article_id");

-- CreateIndex
CREATE INDEX "knowledge_shares_workspace_id_shared_with_user_id_idx" ON "knowledge_shares"("workspace_id", "shared_with_user_id");

-- CreateIndex
CREATE INDEX "knowledge_shares_article_id_idx" ON "knowledge_shares"("article_id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_review_policies_space_id_key" ON "knowledge_review_policies"("space_id");

-- CreateIndex
CREATE INDEX "knowledge_publication_requests_article_id_status_idx" ON "knowledge_publication_requests"("article_id", "status");

-- CreateIndex
CREATE INDEX "knowledge_ack_requirements_workspace_id_article_id_idx" ON "knowledge_ack_requirements"("workspace_id", "article_id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_acknowledgments_requirement_id_employee_user_id_r_key" ON "knowledge_acknowledgments"("requirement_id", "employee_user_id", "revision_id");

-- CreateIndex
CREATE INDEX "knowledge_ai_chunks_workspace_id_indexing_status_idx" ON "knowledge_ai_chunks"("workspace_id", "indexing_status");

-- CreateIndex
CREATE INDEX "knowledge_ai_chunks_article_id_idx" ON "knowledge_ai_chunks"("article_id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_ai_chunks_revision_id_chunk_number_key" ON "knowledge_ai_chunks"("revision_id", "chunk_number");

-- CreateIndex
CREATE INDEX "knowledge_import_jobs_workspace_id_status_idx" ON "knowledge_import_jobs"("workspace_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_import_rows_job_id_ordinal_key" ON "knowledge_import_rows"("job_id", "ordinal");

-- CreateIndex
CREATE INDEX "knowledge_templates_workspace_id_idx" ON "knowledge_templates"("workspace_id");

-- CreateIndex
CREATE INDEX "knowledge_export_jobs_workspace_id_requester_id_idx" ON "knowledge_export_jobs"("workspace_id", "requester_id");

-- CreateIndex
CREATE INDEX "knowledge_lifecycle_events_article_id_idx" ON "knowledge_lifecycle_events"("article_id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_tombstones_article_id_key" ON "knowledge_tombstones"("article_id");

-- CreateIndex
CREATE INDEX "knowledge_tombstones_workspace_id_recover_until_idx" ON "knowledge_tombstones"("workspace_id", "recover_until");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_retention_assignments_resource_id_category_key" ON "knowledge_retention_assignments"("resource_id", "category");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_user_favorites_workspace_id_user_id_article_id_key" ON "knowledge_user_favorites"("workspace_id", "user_id", "article_id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_read_events_dedupe_key_key" ON "knowledge_read_events"("dedupe_key");

-- CreateIndex
CREATE INDEX "knowledge_read_events_workspace_id_article_id_occurred_at_idx" ON "knowledge_read_events"("workspace_id", "article_id", "occurred_at");

-- CreateIndex
CREATE INDEX "knowledge_read_events_workspace_id_reader_id_occurred_at_idx" ON "knowledge_read_events"("workspace_id", "reader_id", "occurred_at");

-- CreateIndex
CREATE INDEX "knowledge_review_assignments_workspace_id_current_state_due_idx" ON "knowledge_review_assignments"("workspace_id", "current_state", "due_at");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_review_assignments_article_id_due_at_key" ON "knowledge_review_assignments"("article_id", "due_at");


-- ---------------------------------------------------------------------------------------------
-- Knowledge invariants.
-- ---------------------------------------------------------------------------------------------
-- Case-normalized article slug unique per sibling scope (live articles only).
CREATE UNIQUE INDEX "knowledge_articles_sibling_slug" ON "knowledge_articles" ("workspace_id", "space_id", COALESCE("parent_article_id", '00000000-0000-0000-0000-000000000000'::uuid), lower("slug")) WHERE "status" NOT IN ('RECYCLED', 'PURGED');
ALTER TABLE "knowledge_articles" ADD CONSTRAINT "knowledge_articles_not_self_parent" CHECK ("parent_article_id" IS NULL OR "parent_article_id" <> "id");
ALTER TABLE "knowledge_articles" ADD CONSTRAINT "knowledge_articles_title_length" CHECK (char_length("title") BETWEEN 1 AND 200);
ALTER TABLE "knowledge_spaces" ADD CONSTRAINT "knowledge_spaces_name_length" CHECK (char_length("name") BETWEEN 1 AND 160);
-- Full-text search over AI chunks (PostgreSQL FTS; vector provider is optional behind the retrieval abstraction).
CREATE INDEX "knowledge_ai_chunks_fts" ON "knowledge_ai_chunks" USING GIN (to_tsvector('simple', "content")) WHERE "indexing_status" = 'ACTIVE';

-- Published revisions and lifecycle history are immutable.
CREATE OR REPLACE FUNCTION knowledge_forbid_history_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'knowledge_revisions' THEN
    -- Revisions are immutable content; only a DRAFT -> PUBLISHED state flip is allowed, and purge may delete rows.
    IF TG_OP = 'UPDATE' AND OLD.state = 'DRAFT' AND NEW.state = 'PUBLISHED' AND NEW.content_hash = OLD.content_hash AND NEW.content_json = OLD.content_json THEN RETURN NEW; END IF;
    IF TG_OP = 'DELETE' AND current_setting('knowledge.purge', true) = 'on' THEN RETURN OLD; END IF;
  END IF;
  RAISE EXCEPTION 'KNOWLEDGE_HISTORY_IMMUTABLE: % rows cannot be changed', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER knowledge_revisions_immutable BEFORE UPDATE OR DELETE ON "knowledge_revisions" FOR EACH ROW EXECUTE FUNCTION knowledge_forbid_history_mutation();
CREATE TRIGGER knowledge_lifecycle_events_append_only BEFORE UPDATE OR DELETE ON "knowledge_lifecycle_events" FOR EACH ROW EXECUTE FUNCTION knowledge_forbid_history_mutation();
CREATE TRIGGER knowledge_acknowledgments_append_only BEFORE UPDATE OR DELETE ON "knowledge_acknowledgments" FOR EACH ROW EXECUTE FUNCTION knowledge_forbid_history_mutation();
