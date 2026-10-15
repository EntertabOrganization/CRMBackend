-- Catalog-owned optional SKU tracking policy (Q29). Variants inherit the parent policy; services are never tracked.
ALTER TABLE "catalog_products" ADD COLUMN "inventory_tracking" TEXT NOT NULL DEFAULT 'NONE',
  ADD COLUMN "enforce_batch_expiry" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "catalog_products" ADD CONSTRAINT catalog_product_tracking_ck CHECK (inventory_tracking IN ('NONE','SERIAL','BATCH')
  AND (inventory_tracking='NONE' OR type<>'SERVICE') AND (NOT enforce_batch_expiry OR inventory_tracking='BATCH'));

-- Serial/batch selections bound to a document line; prior serial state is captured at posting for exact reversal.
CREATE TABLE "inventory_document_line_trackings" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "document_line_id" UUID NOT NULL,
    "serial_id" UUID,
    "batch_id" UUID,
    "quantity" DECIMAL(24,6) NOT NULL,
    "prior_status" TEXT,
    "prior_warehouse_id" UUID,
    CONSTRAINT "inventory_document_line_trackings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "inventory_document_line_trackings_workspace_id_id_key" ON "inventory_document_line_trackings"("workspace_id", "id");
CREATE UNIQUE INDEX "inventory_line_tracking_serial_key" ON "inventory_document_line_trackings"("workspace_id", "document_line_id", "serial_id");
CREATE UNIQUE INDEX "inventory_line_tracking_batch_key" ON "inventory_document_line_trackings"("workspace_id", "document_line_id", "batch_id");
CREATE INDEX "inventory_document_line_trackings_workspace_id_serial_id_idx" ON "inventory_document_line_trackings"("workspace_id", "serial_id");
ALTER TABLE inventory_document_line_trackings
  ADD CONSTRAINT inventory_line_tracking_line_fk FOREIGN KEY (workspace_id,document_id,document_line_id) REFERENCES inventory_document_lines(workspace_id,document_id,id) ON DELETE CASCADE,
  ADD CONSTRAINT inventory_line_tracking_serial_fk FOREIGN KEY (workspace_id,serial_id) REFERENCES inventory_serial_numbers(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT inventory_line_tracking_batch_fk FOREIGN KEY (workspace_id,batch_id) REFERENCES inventory_batches(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT inventory_line_tracking_prior_warehouse_fk FOREIGN KEY (workspace_id,prior_warehouse_id) REFERENCES inventory_warehouses(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT inventory_line_tracking_shape_ck CHECK (quantity>0 AND ((serial_id IS NULL)<>(batch_id IS NULL)) AND (serial_id IS NULL OR quantity=1)
    AND (prior_status IS NULL OR prior_status IN ('IN_STOCK','RESERVED','SOLD','RETURNED','DAMAGED','WRITTEN_OFF')));
CREATE FUNCTION inventory_line_tracking_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_status text; ws uuid; doc uuid; BEGIN
  IF TG_OP='DELETE' THEN ws=OLD.workspace_id; doc=OLD.document_id; ELSE ws=NEW.workspace_id; doc=NEW.document_id; END IF;
  SELECT status INTO owner_status FROM inventory_documents WHERE workspace_id=ws AND id=doc FOR SHARE;
  IF owner_status='PROCESSED' THEN RAISE EXCEPTION 'STOCK_LEDGER_IMMUTABLE'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inventory_line_tracking_immutable BEFORE INSERT OR UPDATE OR DELETE ON inventory_document_line_trackings FOR EACH ROW EXECUTE FUNCTION inventory_line_tracking_guard();

-- Batch quantities per warehouse; changed only by document posting/reversal.
CREATE TABLE "inventory_batch_balances" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "inventory_key" UUID NOT NULL,
    "on_hand" DECIMAL(24,6) NOT NULL DEFAULT 0,
    "version" BIGINT NOT NULL DEFAULT 1,
    CONSTRAINT "inventory_batch_balances_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "inventory_batch_balances_workspace_id_id_key" ON "inventory_batch_balances"("workspace_id", "id");
CREATE UNIQUE INDEX "inventory_batch_balances_workspace_id_warehouse_id_batch_id_key" ON "inventory_batch_balances"("workspace_id", "warehouse_id", "batch_id");
ALTER TABLE inventory_batch_balances
  ADD CONSTRAINT inventory_batch_balance_warehouse_fk FOREIGN KEY (workspace_id,warehouse_id) REFERENCES inventory_warehouses(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT inventory_batch_balance_batch_fk FOREIGN KEY (workspace_id,batch_id) REFERENCES inventory_batches(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT inventory_batch_balance_sku_fk FOREIGN KEY (workspace_id,inventory_key) REFERENCES catalog_products(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT inventory_batch_balance_shape_ck CHECK (on_hand>=0 AND version>0);

-- Negative physical stock (allowNegativeStock) costs the uncovered issue provisionally; the next receipt settles it with explicit variance.
CREATE TABLE "inventory_cost_deficits" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "inventory_key" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "generation" INTEGER NOT NULL,
    "issue_movement_id" UUID NOT NULL,
    "quantity" DECIMAL(24,6) NOT NULL,
    "remaining_qty" DECIMAL(24,6) NOT NULL,
    "provisional_unit_cost" DECIMAL(24,6) NOT NULL,
    "cancelled_by_movement_id" UUID,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "inventory_cost_deficits_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "inventory_cost_deficits_workspace_id_id_key" ON "inventory_cost_deficits"("workspace_id", "id");
CREATE UNIQUE INDEX "inventory_cost_deficits_workspace_id_issue_movement_id_key" ON "inventory_cost_deficits"("workspace_id", "issue_movement_id");
CREATE INDEX "inventory_cost_deficits_workspace_id_warehouse_id_inventory__idx" ON "inventory_cost_deficits"("workspace_id", "warehouse_id", "inventory_key", "currency", "generation", "remaining_qty");
ALTER TABLE inventory_cost_deficits
  ADD CONSTRAINT inventory_cost_deficit_warehouse_fk FOREIGN KEY (workspace_id,warehouse_id) REFERENCES inventory_warehouses(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT inventory_cost_deficit_sku_fk FOREIGN KEY (workspace_id,inventory_key) REFERENCES catalog_products(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT inventory_cost_deficit_issue_fk FOREIGN KEY (workspace_id,issue_movement_id) REFERENCES inventory_movements(workspace_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT inventory_cost_deficit_cancel_fk FOREIGN KEY (workspace_id,cancelled_by_movement_id) REFERENCES inventory_movements(workspace_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT inventory_cost_deficit_shape_ck CHECK (quantity>0 AND remaining_qty>=0 AND remaining_qty<=quantity AND provisional_unit_cost>=0
    AND generation>0 AND currency ~ '^[A-Z]{3}$' AND (cancelled_by_movement_id IS NULL OR remaining_qty=0));
CREATE FUNCTION inventory_cost_deficit_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'STOCK_LEDGER_IMMUTABLE'; END IF;
  IF (to_jsonb(OLD)-ARRAY['remaining_qty','cancelled_by_movement_id']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['remaining_qty','cancelled_by_movement_id'])
    OR NEW.remaining_qty>OLD.remaining_qty THEN RAISE EXCEPTION 'STOCK_LEDGER_IMMUTABLE'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inventory_cost_deficit_history BEFORE UPDATE OR DELETE ON inventory_cost_deficits FOR EACH ROW EXECUTE FUNCTION inventory_cost_deficit_history_guard();

CREATE TABLE "inventory_cost_deficit_settlements" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "deficit_id" UUID NOT NULL,
    "receipt_movement_id" UUID NOT NULL,
    "quantity" DECIMAL(24,6) NOT NULL,
    "actual_unit_cost" DECIMAL(24,6) NOT NULL,
    "variance_value" DECIMAL(24,6) NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "inventory_cost_deficit_settlements_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "inventory_cost_deficit_settlements_workspace_id_id_key" ON "inventory_cost_deficit_settlements"("workspace_id", "id");
CREATE UNIQUE INDEX "inventory_cost_deficit_settlements_workspace_id_deficit_id_r_key" ON "inventory_cost_deficit_settlements"("workspace_id", "deficit_id", "receipt_movement_id");
CREATE INDEX "inventory_cost_deficit_settlements_workspace_id_receipt_mov_idx" ON "inventory_cost_deficit_settlements"("workspace_id", "receipt_movement_id");
ALTER TABLE inventory_cost_deficit_settlements
  ADD CONSTRAINT inventory_deficit_settlement_owner_fk FOREIGN KEY (workspace_id,deficit_id) REFERENCES inventory_cost_deficits(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT inventory_deficit_settlement_receipt_fk FOREIGN KEY (workspace_id,receipt_movement_id) REFERENCES inventory_movements(workspace_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT inventory_deficit_settlement_shape_ck CHECK (quantity>0 AND actual_unit_cost>=0);
CREATE TRIGGER inventory_deficit_settlement_immutable BEFORE UPDATE OR DELETE ON inventory_cost_deficit_settlements FOR EACH ROW EXECUTE FUNCTION inventory_reject_evidence_change();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['inventory_document_line_trackings','inventory_batch_balances','inventory_cost_deficits','inventory_cost_deficit_settlements'] LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT',t,t||'_workspace_fk');
  END LOOP;
END $$;

-- Explicit, separately authorized stocktake skip of an uncounted line (zero variance, audited).
ALTER TABLE "stocktake_lines" ADD COLUMN "skip_approved_by_user_id" UUID, ADD COLUMN "skip_reason" TEXT, ADD COLUMN "skipped_at" TIMESTAMPTZ(6);
ALTER TABLE stocktake_lines
  ADD CONSTRAINT stocktake_line_skip_actor_fk FOREIGN KEY (workspace_id,skip_approved_by_user_id) REFERENCES workspace_memberships(workspace_id,user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT stocktake_line_skip_ck CHECK (((skip_approved_by_user_id IS NULL)=(skip_reason IS NULL)) AND ((skip_reason IS NULL)=(skipped_at IS NULL))
    AND (skipped_at IS NULL OR counted_qty IS NULL) AND (skip_reason IS NULL OR length(skip_reason) BETWEEN 1 AND 2000));
