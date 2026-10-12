-- CreateTable
CREATE TABLE "spa_import_jobs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "type_id" UUID NOT NULL,
    "mode" TEXT NOT NULL,
    "mapping_json" JSONB NOT NULL,
    "source_file_id" UUID NOT NULL,
    "source_system" TEXT,
    "external_key_column" TEXT,
    "source_version_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "cancel_requested" BOOLEAN NOT NULL DEFAULT false,
    "totals_json" JSONB NOT NULL DEFAULT '{}',
    "error_code" TEXT,
    "report_file_id" UUID,
    "claim_token" UUID,
    "lease_expires_at" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "correlation_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spa_import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spa_import_rows" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "row_number" INTEGER NOT NULL,
    "external_source" TEXT,
    "external_id" TEXT,
    "status" TEXT NOT NULL,
    "error_codes_json" JSONB NOT NULL DEFAULT '[]',
    "item_id" UUID,

    CONSTRAINT "spa_import_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spa_item_external_keys" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "type_id" UUID NOT NULL,
    "source_system" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "item_id" UUID,
    "tombstoned_at" TIMESTAMPTZ(6),

    CONSTRAINT "spa_item_external_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spa_export_jobs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "type_id" UUID NOT NULL,
    "scope_snapshot_json" JSONB NOT NULL,
    "requested_by" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "download_file_id" UUID,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "error_code" TEXT,
    "claim_token" UUID,
    "lease_expires_at" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "correlation_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spa_export_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spa_purge_jobs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "type_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "requested_by" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "legal_hold_checked_at" TIMESTAMPTZ(6),
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "claim_token" UUID,
    "lease_expires_at" TIMESTAMPTZ(6),
    "error_code" TEXT,
    "correlation_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spa_purge_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "spa_import_jobs_status_next_attempt_at_idx" ON "spa_import_jobs"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "spa_import_jobs_workspace_id_id_key" ON "spa_import_jobs"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "spa_import_rows_workspace_id_job_id_row_number_key" ON "spa_import_rows"("workspace_id", "job_id", "row_number");

-- CreateIndex
CREATE UNIQUE INDEX "spa_item_external_keys_workspace_id_type_id_source_system_e_key" ON "spa_item_external_keys"("workspace_id", "type_id", "source_system", "external_id");

-- CreateIndex
CREATE INDEX "spa_export_jobs_status_next_attempt_at_idx" ON "spa_export_jobs"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "spa_export_jobs_workspace_id_id_key" ON "spa_export_jobs"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "spa_purge_jobs_status_created_at_idx" ON "spa_purge_jobs"("status", "created_at");

-- Transfers retain durable identities; every live reference is tenant constrained.
CREATE UNIQUE INDEX IF NOT EXISTS "files_workspace_id_id_spa_fk" ON "drive_files"("workspace_id", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "file_versions_workspace_id_id_spa_fk" ON "drive_file_versions"("workspace_id", "id");
ALTER TABLE spa_import_jobs
  ADD CONSTRAINT spa_import_type_fk FOREIGN KEY (workspace_id,type_id) REFERENCES spa_entity_types(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT spa_import_actor_fk FOREIGN KEY (workspace_id,created_by_user_id) REFERENCES workspace_memberships(workspace_id,user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT spa_import_file_fk FOREIGN KEY (workspace_id,source_file_id) REFERENCES drive_files(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT spa_import_source_version_fk FOREIGN KEY (workspace_id,source_version_id) REFERENCES drive_file_versions(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT spa_import_report_fk FOREIGN KEY (workspace_id,report_file_id) REFERENCES drive_files(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT spa_import_state_ck CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED') AND mode IN ('CREATE_ONLY','UPSERT_BY_EXTERNAL_KEY') AND attempts >= 0),
  ADD CONSTRAINT spa_import_external_key_ck CHECK (mode <> 'UPSERT_BY_EXTERNAL_KEY' OR (source_system IS NOT NULL AND external_key_column IS NOT NULL)),
  ADD CONSTRAINT spa_import_lease_ck CHECK ((status='RUNNING')=(claim_token IS NOT NULL AND lease_expires_at IS NOT NULL));
ALTER TABLE spa_import_rows
  ADD CONSTRAINT spa_import_row_job_fk FOREIGN KEY (workspace_id,job_id) REFERENCES spa_import_jobs(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT spa_import_row_ck CHECK (row_number >= 2 AND status IN ('SUCCEEDED','FAILED') AND jsonb_typeof(error_codes_json)='array');
-- Outcome item_id deliberately survives physical purge as immutable historical evidence.
ALTER TABLE spa_item_external_keys
  ADD CONSTRAINT spa_external_type_fk FOREIGN KEY (workspace_id,type_id) REFERENCES spa_entity_types(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT spa_external_item_fk FOREIGN KEY (workspace_id,type_id,item_id) REFERENCES spa_items(workspace_id,type_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT spa_external_tombstone_ck CHECK ((item_id IS NULL)=(tombstoned_at IS NOT NULL));
ALTER TABLE spa_export_jobs
  ADD CONSTRAINT spa_export_type_fk FOREIGN KEY (workspace_id,type_id) REFERENCES spa_entity_types(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT spa_export_actor_fk FOREIGN KEY (workspace_id,requested_by) REFERENCES workspace_memberships(workspace_id,user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT spa_export_file_fk FOREIGN KEY (workspace_id,download_file_id) REFERENCES drive_files(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT spa_export_state_ck CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED') AND attempts >= 0 AND expires_at > created_at),
  ADD CONSTRAINT spa_export_lease_ck CHECK ((status='RUNNING')=(claim_token IS NOT NULL AND lease_expires_at IS NOT NULL));
ALTER TABLE spa_purge_jobs
  ADD CONSTRAINT spa_purge_type_fk FOREIGN KEY (workspace_id,type_id) REFERENCES spa_entity_types(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT spa_purge_actor_fk FOREIGN KEY (workspace_id,requested_by) REFERENCES workspace_memberships(workspace_id,user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT spa_purge_state_ck CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED') AND attempt_count >= 0),
  ADD CONSTRAINT spa_purge_lease_ck CHECK ((status='RUNNING')=(claim_token IS NOT NULL AND lease_expires_at IS NOT NULL));
CREATE UNIQUE INDEX spa_purge_one_active_item ON spa_purge_jobs(workspace_id,item_id) WHERE status IN ('QUEUED','RUNNING');
CREATE FUNCTION spa_validate_import_source_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_version_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM drive_file_versions v WHERE v.workspace_id=NEW.workspace_id AND v.id=NEW.source_version_id AND v.file_id=NEW.source_file_id) THEN
    RAISE EXCEPTION 'SPA_IMPORT_SOURCE_VERSION_INVALID' USING ERRCODE='23503';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER spa_import_source_version BEFORE INSERT OR UPDATE ON spa_import_jobs FOR EACH ROW EXECUTE FUNCTION spa_validate_import_source_version();
