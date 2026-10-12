-- AlterTable
ALTER TABLE "workflow_node_executions" ADD COLUMN     "retry_budget" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "integration_outbound_connections" ADD COLUMN     "supports_idempotency" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "workflow_event_deliveries" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "claim_token" UUID,
    "lease_expires_at" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "error_code" TEXT,
    "result" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_event_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workflow_event_deliveries_status_next_attempt_at_idx" ON "workflow_event_deliveries"("status", "next_attempt_at");
CREATE UNIQUE INDEX IF NOT EXISTS outbox_workflow_tenant_event ON outbox_events(workspace_id,id);
ALTER TABLE workflow_event_deliveries
  ADD CONSTRAINT workflow_event_delivery_fk FOREIGN KEY (workspace_id,event_id) REFERENCES outbox_events(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT workflow_event_delivery_state_ck CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED') AND attempts >= 0);
ALTER TABLE workflow_node_executions ADD CONSTRAINT workflow_retry_budget_ck CHECK (retry_budget >= 0);
-- Owning action events preserve their workflow cause without changing the shared producer API.
CREATE FUNCTION workflow_stamp_outbox_cause() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE execution_id text; chain_depth text;
BEGIN
  execution_id := current_setting('truecrm.workflow_execution_id',true);
  chain_depth := current_setting('truecrm.workflow_depth',true);
  IF execution_id IS NOT NULL AND execution_id <> '' THEN
    NEW.causation_id := execution_id;
    NEW.correlation_id := COALESCE(NEW.correlation_id,execution_id);
    NEW.automation_depth := GREATEST(NEW.automation_depth,COALESCE(NULLIF(chain_depth,'')::integer,0));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workflow_outbox_cause BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION workflow_stamp_outbox_cause();
ALTER TABLE workflow_triggers ADD COLUMN created_at timestamptz(6) NOT NULL DEFAULT now();
ALTER TABLE workflow_event_subscriptions ADD COLUMN created_at timestamptz(6) NOT NULL DEFAULT now();
ALTER TABLE workflow_triggers ADD COLUMN next_attempt_at timestamptz(6), ADD COLUMN failure_count integer NOT NULL DEFAULT 0, ADD COLUMN last_error_code text,
  ADD CONSTRAINT workflow_trigger_failures_ck CHECK (failure_count >= 0);
ALTER TABLE workflow_external_callbacks ADD COLUMN received_payload jsonb;
CREATE UNIQUE INDEX workflow_callback_one_node ON workflow_external_callbacks(workspace_id,node_run_id);

-- CreateIndex
CREATE UNIQUE INDEX "workflow_event_deliveries_workspace_id_event_id_key" ON "workflow_event_deliveries"("workspace_id", "event_id");
