CREATE TABLE inventory_controlled_approvals (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  preview_job_id UUID NOT NULL,
  approved_by_user_id UUID NOT NULL,
  operation TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  reason TEXT NOT NULL,
  expires_at TIMESTAMPTZ(6) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT inventory_controlled_approval_shape CHECK (operation IN ('COSTING_MIGRATE','RESET_APPLY') AND length(source_hash)=64 AND length(reason) BETWEEN 1 AND 2000 AND expires_at>created_at),
  CONSTRAINT inventory_controlled_approval_workspace_fk FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
  CONSTRAINT inventory_controlled_approval_preview_fk FOREIGN KEY (workspace_id,preview_job_id) REFERENCES inventory_jobs(workspace_id,id) ON DELETE RESTRICT,
  CONSTRAINT inventory_controlled_approval_actor_fk FOREIGN KEY (workspace_id,approved_by_user_id) REFERENCES workspace_memberships(workspace_id,user_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX inventory_controlled_approvals_workspace_id_id_key ON inventory_controlled_approvals(workspace_id,id);
CREATE UNIQUE INDEX inventory_controlled_approvals_workspace_id_preview_job_id_approved_by_user_id_key ON inventory_controlled_approvals(workspace_id,preview_job_id,approved_by_user_id);
CREATE TRIGGER inventory_controlled_approval_immutable BEFORE UPDATE OR DELETE ON inventory_controlled_approvals FOR EACH ROW EXECUTE FUNCTION inventory_reject_evidence_change();
ALTER TABLE inventory_cost_layers ALTER COLUMN source_document_line_id DROP NOT NULL,ALTER COLUMN source_movement_id DROP NOT NULL;
ALTER TABLE inventory_cost_layers ADD COLUMN opening_snapshot_id UUID;
CREATE UNIQUE INDEX inventory_cost_layers_opening_snapshot_id_key ON inventory_cost_layers(opening_snapshot_id);
ALTER TABLE inventory_cost_layers ADD CONSTRAINT inventory_layer_opening_fk FOREIGN KEY (workspace_id,opening_snapshot_id) REFERENCES inventory_valuation_snapshots(workspace_id,id) ON DELETE RESTRICT;
ALTER TABLE inventory_cost_layers ADD CONSTRAINT inventory_layer_origin_shape CHECK (
  (opening_snapshot_id IS NULL AND source_document_line_id IS NOT NULL AND source_movement_id IS NOT NULL)
  OR (opening_snapshot_id IS NOT NULL AND source_document_line_id IS NULL AND source_movement_id IS NULL));
ALTER TABLE inventory_jobs ADD CONSTRAINT inventory_job_controlled_approval_fk FOREIGN KEY (workspace_id,approval_reference) REFERENCES inventory_controlled_approvals(workspace_id,id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX inventory_job_controlled_approval_once ON inventory_jobs(workspace_id,approval_reference) WHERE approval_reference IS NOT NULL;
CREATE OR REPLACE FUNCTION inventory_layer_origin_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.opening_snapshot_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM inventory_valuation_snapshots s JOIN inventory_jobs j ON j.workspace_id=s.workspace_id AND j.id=s.job_id
      WHERE s.workspace_id=NEW.workspace_id AND s.id=NEW.opening_snapshot_id AND s.warehouse_id=NEW.warehouse_id
        AND s.inventory_key=NEW.inventory_key AND s.currency=NEW.currency AND s.generation=NEW.generation AND s.method='FIFO'
        AND s.quantity=NEW.original_qty AND s.total_value=NEW.original_value AND j.type='COSTING_MIGRATE' AND j.status='SUCCEEDED')
      THEN RAISE EXCEPTION 'COSTING_RECONCILIATION_FAILED' USING ERRCODE='23503'; END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM inventory_movements m WHERE m.workspace_id=NEW.workspace_id AND m.id=NEW.source_movement_id
    AND m.document_line_id=NEW.source_document_line_id AND m.warehouse_id=NEW.warehouse_id AND m.inventory_key=NEW.inventory_key
    AND m.currency=NEW.currency AND m.quantity_delta>0 AND m.valuation_generation=NEW.generation)
    THEN RAISE EXCEPTION 'COSTING_RECONCILIATION_FAILED' USING ERRCODE='23503'; END IF;
  RETURN NEW;
END $$;
