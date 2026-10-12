-- AlterTable
ALTER TABLE "inventory_settings" ADD COLUMN     "valuation_generation" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "inventory_cost_layers" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "inventory_key" UUID NOT NULL,
    "source_document_line_id" UUID NOT NULL,
    "source_movement_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL DEFAULT 0,
    "original_qty" DECIMAL(24,6) NOT NULL,
    "remaining_qty" DECIMAL(24,6) NOT NULL,
    "unit_cost" DECIMAL(24,6) NOT NULL,
    "original_value" DECIMAL(24,6) NOT NULL,
    "remaining_value" DECIMAL(24,6) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "inventory_cost_layers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_cost_allocations" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "movement_id" UUID NOT NULL,
    "layer_id" UUID NOT NULL,
    "quantity" DECIMAL(24,6) NOT NULL,
    "unit_cost" DECIMAL(24,6) NOT NULL,
    "total_cost" DECIMAL(24,6) NOT NULL,

    CONSTRAINT "inventory_cost_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_average_costs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "inventory_key" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "quantity" DECIMAL(24,6) NOT NULL,
    "total_value" DECIMAL(24,6) NOT NULL,
    "average_cost" DECIMAL(24,6) NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "version" BIGINT NOT NULL DEFAULT 1,

    CONSTRAINT "inventory_average_costs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_valuation_snapshots" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "inventory_key" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "as_of_at" TIMESTAMPTZ(6) NOT NULL,
    "quantity" DECIMAL(24,6) NOT NULL,
    "total_value" DECIMAL(24,6) NOT NULL,
    "method" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "job_id" UUID,

    CONSTRAINT "inventory_valuation_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_jobs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "requested_by_user_id" UUID NOT NULL,
    "input" JSONB NOT NULL,
    "result" JSONB,
    "source_hash" TEXT,
    "report_file_id" UUID,
    "approval_reference" UUID,
    "correlation_id" UUID NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "lease_owner" UUID,
    "lease_until" TIMESTAMPTZ(6),
    "error_code" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "inventory_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_document_approvals" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "document_version" BIGINT NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "decision" TEXT NOT NULL,
    "comment" TEXT,
    "policy_snapshot" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_document_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_numbering_schemes" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "document_type" TEXT NOT NULL,
    "prefix_template" TEXT NOT NULL,
    "padding" INTEGER NOT NULL DEFAULT 6,
    "reset_policy" TEXT NOT NULL DEFAULT 'NEVER',
    "period_key" TEXT NOT NULL DEFAULT '',
    "next_value" BIGINT NOT NULL DEFAULT 1,
    "version" BIGINT NOT NULL DEFAULT 1,

    CONSTRAINT "inventory_numbering_schemes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stocktake_lines" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "variant_id" UUID,
    "inventory_key" UUID NOT NULL,
    "location_id" UUID,
    "location_key" TEXT NOT NULL DEFAULT '',
    "expected_qty" DECIMAL(24,6) NOT NULL,
    "expected_balance_version" BIGINT NOT NULL,
    "counted_qty" DECIMAL(24,6),
    "counted_by_user_id" UUID,
    "counted_at" TIMESTAMPTZ(6),
    "variance_qty" DECIMAL(24,6),
    "reconciled_balance_version" BIGINT,
    "reconciliation_qty" DECIMAL(24,6),
    "adjustment_document_line_id" UUID,
    "version" BIGINT NOT NULL DEFAULT 1,

    CONSTRAINT "stocktake_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stocktake_count_history" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "line_id" UUID NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "quantity" DECIMAL(24,6) NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stocktake_count_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_barcodes" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "variant_id" UUID,
    "inventory_key" UUID NOT NULL,
    "barcode_type" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "product_barcodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_serial_numbers" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "variant_id" UUID,
    "inventory_key" UUID NOT NULL,
    "serial_number" TEXT NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "receipt_document_line_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'IN_STOCK',

    CONSTRAINT "inventory_serial_numbers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_batches" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "variant_id" UUID,
    "inventory_key" UUID NOT NULL,
    "batch_number" TEXT NOT NULL,
    "manufactured_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',

    CONSTRAINT "inventory_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_reorder_settings" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "variant_id" UUID,
    "inventory_key" UUID NOT NULL,
    "reorder_point" DECIMAL(24,6) NOT NULL,
    "reorder_quantity" DECIMAL(24,6) NOT NULL,
    "safety_stock" DECIMAL(24,6) NOT NULL DEFAULT 0,
    "preferred_vendor_id" UUID,
    "version" BIGINT NOT NULL DEFAULT 1,

    CONSTRAINT "inventory_reorder_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_low_stock_alerts" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "inventory_key" UUID NOT NULL,
    "threshold" DECIMAL(24,6) NOT NULL,
    "open_since" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),

    CONSTRAINT "inventory_low_stock_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_cost_layers_workspace_id_warehouse_id_inventory_k_idx" ON "inventory_cost_layers"("workspace_id", "warehouse_id", "inventory_key", "currency", "generation", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_cost_layers_workspace_id_id_key" ON "inventory_cost_layers"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_cost_layers_workspace_id_source_movement_id_gener_key" ON "inventory_cost_layers"("workspace_id", "source_movement_id", "generation", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_cost_allocations_workspace_id_id_key" ON "inventory_cost_allocations"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_cost_allocations_workspace_id_movement_id_layer_i_key" ON "inventory_cost_allocations"("workspace_id", "movement_id", "layer_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_average_costs_workspace_id_id_key" ON "inventory_average_costs"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_average_costs_workspace_id_warehouse_id_inventory_key" ON "inventory_average_costs"("workspace_id", "warehouse_id", "inventory_key", "currency", "generation");

-- CreateIndex
CREATE INDEX "inventory_valuation_snapshots_workspace_id_warehouse_id_inv_idx" ON "inventory_valuation_snapshots"("workspace_id", "warehouse_id", "inventory_key", "as_of_at");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_valuation_snapshots_workspace_id_id_key" ON "inventory_valuation_snapshots"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "inventory_jobs_status_lease_until_created_at_idx" ON "inventory_jobs"("status", "lease_until", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_jobs_workspace_id_id_key" ON "inventory_jobs"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_document_approvals_workspace_id_id_key" ON "inventory_document_approvals"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_document_approvals_workspace_id_document_id_docum_key" ON "inventory_document_approvals"("workspace_id", "document_id", "document_version", "actor_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_numbering_schemes_workspace_id_id_key" ON "inventory_numbering_schemes"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_numbering_schemes_workspace_id_document_type_key" ON "inventory_numbering_schemes"("workspace_id", "document_type");

-- CreateIndex
CREATE UNIQUE INDEX "stocktake_lines_workspace_id_id_key" ON "stocktake_lines"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "stocktake_lines_workspace_id_session_id_inventory_key_locat_key" ON "stocktake_lines"("workspace_id", "session_id", "inventory_key", "location_key");

-- CreateIndex
CREATE INDEX "stocktake_count_history_workspace_id_session_id_occurred_at_idx" ON "stocktake_count_history"("workspace_id", "session_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "stocktake_count_history_workspace_id_id_key" ON "stocktake_count_history"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "product_barcodes_workspace_id_id_key" ON "product_barcodes"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "product_barcodes_workspace_id_value_key" ON "product_barcodes"("workspace_id", "value");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_serial_numbers_workspace_id_id_key" ON "inventory_serial_numbers"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_serial_numbers_workspace_id_inventory_key_serial__key" ON "inventory_serial_numbers"("workspace_id", "inventory_key", "serial_number");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_batches_workspace_id_id_key" ON "inventory_batches"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_batches_workspace_id_inventory_key_batch_number_key" ON "inventory_batches"("workspace_id", "inventory_key", "batch_number");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_reorder_settings_workspace_id_id_key" ON "inventory_reorder_settings"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_reorder_settings_workspace_id_warehouse_id_invent_key" ON "inventory_reorder_settings"("workspace_id", "warehouse_id", "inventory_key");

-- CreateIndex
CREATE INDEX "inventory_low_stock_alerts_workspace_id_warehouse_id_resolv_idx" ON "inventory_low_stock_alerts"("workspace_id", "warehouse_id", "resolved_at");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_low_stock_alerts_workspace_id_id_key" ON "inventory_low_stock_alerts"("workspace_id", "id");

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['inventory_cost_layers','inventory_cost_allocations','inventory_average_costs','inventory_valuation_snapshots','inventory_jobs',
    'inventory_document_approvals','inventory_numbering_schemes','stocktake_lines','stocktake_count_history','product_barcodes',
    'inventory_serial_numbers','inventory_batches','inventory_reorder_settings','inventory_low_stock_alerts'] LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT',t,t||'_workspace_fk');
  END LOOP;
  FOREACH t IN ARRAY ARRAY['inventory_cost_layers','inventory_average_costs','inventory_valuation_snapshots','inventory_serial_numbers','inventory_reorder_settings','inventory_low_stock_alerts'] LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (workspace_id,warehouse_id) REFERENCES inventory_warehouses(workspace_id,id) ON DELETE RESTRICT',t,t||'_warehouse_fk');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (workspace_id,inventory_key) REFERENCES catalog_products(workspace_id,id) ON DELETE RESTRICT',t,t||'_sku_fk');
  END LOOP;
  FOREACH t IN ARRAY ARRAY['stocktake_lines','product_barcodes','inventory_serial_numbers','inventory_batches','inventory_reorder_settings'] LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (workspace_id,product_id) REFERENCES catalog_products(workspace_id,id) ON DELETE RESTRICT',t,t||'_product_fk');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (workspace_id,variant_id) REFERENCES catalog_products(workspace_id,id) ON DELETE RESTRICT',t,t||'_variant_fk');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (inventory_key=COALESCE(variant_id,product_id))',t,t||'_inventory_key_ck');
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OF product_id,variant_id,inventory_key ON %I FOR EACH ROW EXECUTE FUNCTION inventory_sku_guard()',t||'_sku_guard',t);
  END LOOP;
END $$;
ALTER TABLE inventory_settings ADD CONSTRAINT inventory_generation_ck CHECK (valuation_generation>0);
ALTER TABLE inventory_movements ADD COLUMN costing_method TEXT NOT NULL DEFAULT 'FIFO',ADD COLUMN valuation_generation INTEGER NOT NULL DEFAULT 1;
ALTER TABLE inventory_movements ADD CONSTRAINT inventory_movement_cost_policy_ck CHECK (costing_method IN ('FIFO','AVERAGE') AND valuation_generation>0);
ALTER TABLE inventory_cost_layers
  ADD CONSTRAINT inventory_layer_source_fk FOREIGN KEY (workspace_id,source_document_line_id) REFERENCES inventory_document_lines(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT inventory_layer_movement_fk FOREIGN KEY (workspace_id,source_movement_id) REFERENCES inventory_movements(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT inventory_layer_shape_ck CHECK (original_qty>0 AND remaining_qty>=0 AND remaining_qty<=original_qty AND unit_cost>=0
    AND original_value>=0 AND remaining_value>=0 AND remaining_value<=original_value AND generation>0 AND ordinal>=0 AND currency ~ '^[A-Z]{3}$'
    AND (remaining_qty<>0 OR remaining_value=0));
ALTER TABLE inventory_cost_allocations
  ADD CONSTRAINT inventory_cost_allocation_movement_fk FOREIGN KEY (workspace_id,movement_id) REFERENCES inventory_movements(workspace_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT inventory_cost_allocation_layer_fk FOREIGN KEY (workspace_id,layer_id) REFERENCES inventory_cost_layers(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT inventory_cost_allocation_shape_ck CHECK (quantity>0 AND unit_cost>=0 AND total_cost>=0);
ALTER TABLE inventory_average_costs ADD CONSTRAINT inventory_average_shape_ck CHECK (version>0 AND generation>0 AND quantity>=0 AND total_value>=0 AND average_cost>=0
  AND currency ~ '^[A-Z]{3}$' AND (quantity<>0 OR total_value=0));
ALTER TABLE inventory_valuation_snapshots
  ADD CONSTRAINT inventory_snapshot_job_fk FOREIGN KEY (workspace_id,job_id) REFERENCES inventory_jobs(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT inventory_snapshot_shape_ck CHECK (generation>0 AND method IN ('FIFO','AVERAGE') AND currency ~ '^[A-Z]{3}$');
ALTER TABLE inventory_jobs
  ADD CONSTRAINT inventory_job_actor_fk FOREIGN KEY (workspace_id,requested_by_user_id) REFERENCES workspace_memberships(workspace_id,user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT inventory_job_report_fk FOREIGN KEY (workspace_id,report_file_id) REFERENCES drive_files(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT inventory_job_shape_ck CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED') AND attempt_count>=0 AND (lease_owner IS NULL)=(lease_until IS NULL)
    AND (status<>'RUNNING' OR lease_owner IS NOT NULL) AND type IN ('STOCK_RECONCILE','COSTING_PREVIEW','COSTING_MIGRATE','RESET_PREVIEW','RESET_APPLY'));
ALTER TABLE inventory_document_approvals
  ADD CONSTRAINT inventory_approval_document_fk FOREIGN KEY (workspace_id,document_id) REFERENCES inventory_documents(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT inventory_approval_actor_fk FOREIGN KEY (workspace_id,actor_user_id) REFERENCES workspace_memberships(workspace_id,user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT inventory_approval_shape_ck CHECK (document_version>0 AND decision IN ('APPROVE','REJECT'));
ALTER TABLE inventory_numbering_schemes ADD CONSTRAINT inventory_numbering_shape_ck CHECK (next_value>0 AND version>0 AND padding BETWEEN 1 AND 18 AND reset_policy IN ('NEVER','YEARLY','MONTHLY')
  AND document_type IN ('STOCK_RECEIPT','STOCK_ADJUSTMENT','TRANSFER','SALES_ORDER','CUSTOMER_RETURN','SUPPLIER_RETURN','WRITE_OFF'));
ALTER TABLE stocktake_lines
  ADD CONSTRAINT stocktake_line_owner_fk FOREIGN KEY (workspace_id,session_id) REFERENCES stocktake_sessions(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT stocktake_line_location_fk FOREIGN KEY (workspace_id,location_id) REFERENCES inventory_locations(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT stocktake_line_counter_fk FOREIGN KEY (workspace_id,counted_by_user_id) REFERENCES workspace_memberships(workspace_id,user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT stocktake_line_adjustment_fk FOREIGN KEY (workspace_id,adjustment_document_line_id) REFERENCES inventory_document_lines(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT stocktake_line_shape_ck CHECK (version>0 AND expected_balance_version>=0 AND (counted_qty IS NULL OR counted_qty>=0)
    AND (counted_qty IS NULL)=(counted_at IS NULL) AND (counted_qty IS NULL)=(counted_by_user_id IS NULL) AND location_key=COALESCE(location_id::text,''));
CREATE UNIQUE INDEX stocktake_line_parent_identity ON stocktake_lines(workspace_id,session_id,id);
ALTER TABLE stocktake_count_history
  ADD CONSTRAINT stocktake_count_line_fk FOREIGN KEY (workspace_id,session_id,line_id) REFERENCES stocktake_lines(workspace_id,session_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT stocktake_count_actor_fk FOREIGN KEY (workspace_id,actor_user_id) REFERENCES workspace_memberships(workspace_id,user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT stocktake_count_quantity_ck CHECK (quantity>=0);
ALTER TABLE product_barcodes ADD CONSTRAINT inventory_barcode_type_ck CHECK (barcode_type IN ('EAN13','UPC','CODE128','QR','CUSTOM') AND length(value) BETWEEN 1 AND 200);
CREATE UNIQUE INDEX inventory_barcode_primary ON product_barcodes(workspace_id,inventory_key) WHERE is_primary AND is_active;
ALTER TABLE inventory_serial_numbers
  ADD CONSTRAINT inventory_serial_receipt_fk FOREIGN KEY (workspace_id,receipt_document_line_id) REFERENCES inventory_document_lines(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT inventory_serial_shape_ck CHECK (status IN ('IN_STOCK','RESERVED','SOLD','RETURNED','DAMAGED','WRITTEN_OFF') AND length(serial_number) BETWEEN 1 AND 160);
ALTER TABLE inventory_batches ADD CONSTRAINT inventory_batch_shape_ck CHECK (status IN ('ACTIVE','ARCHIVED') AND length(batch_number) BETWEEN 1 AND 160 AND (manufactured_at IS NULL OR expires_at IS NULL OR manufactured_at<expires_at));
ALTER TABLE inventory_reorder_settings ADD CONSTRAINT inventory_reorder_shape_ck CHECK (version>0 AND reorder_point>=0 AND reorder_quantity>0 AND safety_stock>=0);
CREATE UNIQUE INDEX inventory_low_stock_open ON inventory_low_stock_alerts(workspace_id,warehouse_id,inventory_key) WHERE resolved_at IS NULL;
CREATE TRIGGER inventory_cost_allocation_immutable BEFORE UPDATE OR DELETE ON inventory_cost_allocations FOR EACH ROW EXECUTE FUNCTION inventory_reject_evidence_change();
CREATE TRIGGER inventory_valuation_snapshot_immutable BEFORE UPDATE OR DELETE ON inventory_valuation_snapshots FOR EACH ROW EXECUTE FUNCTION inventory_reject_evidence_change();
CREATE TRIGGER inventory_approval_immutable BEFORE UPDATE OR DELETE ON inventory_document_approvals FOR EACH ROW EXECUTE FUNCTION inventory_reject_evidence_change();
CREATE TRIGGER stocktake_count_immutable BEFORE UPDATE OR DELETE ON stocktake_count_history FOR EACH ROW EXECUTE FUNCTION inventory_reject_evidence_change();
CREATE FUNCTION inventory_cost_layer_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'STOCK_LEDGER_IMMUTABLE'; END IF;
  IF (to_jsonb(OLD)-ARRAY['remaining_qty','remaining_value']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['remaining_qty','remaining_value']) THEN
    RAISE EXCEPTION 'STOCK_LEDGER_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inventory_cost_layer_history BEFORE UPDATE OR DELETE ON inventory_cost_layers FOR EACH ROW EXECUTE FUNCTION inventory_cost_layer_history_guard();
CREATE FUNCTION inventory_allocation_owner_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM inventory_movements m JOIN inventory_cost_layers l ON l.workspace_id=m.workspace_id AND l.id=NEW.layer_id
    WHERE m.workspace_id=NEW.workspace_id AND m.id=NEW.movement_id AND m.quantity_delta<0 AND m.warehouse_id=l.warehouse_id
      AND m.inventory_key=l.inventory_key AND m.currency=l.currency) THEN RAISE EXCEPTION 'COSTING_RECONCILIATION_FAILED' USING ERRCODE='23503'; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER inventory_allocation_owner AFTER INSERT ON inventory_cost_allocations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inventory_allocation_owner_guard();

-- Validate final committed reservation state, allowing atomic allocation/quantity changes in either order.
CREATE FUNCTION inventory_reservation_allocation_total_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ws uuid; rid uuid; remaining numeric; allocated numeric;
BEGIN
  IF TG_TABLE_NAME='inventory_reservations' THEN ws:=NEW.workspace_id; rid:=NEW.id;
  ELSIF TG_OP='DELETE' THEN ws:=OLD.workspace_id; rid:=OLD.reservation_id;
  ELSE ws:=NEW.workspace_id; rid:=NEW.reservation_id; END IF;
  SELECT quantity-fulfilled_quantity-released_quantity INTO remaining FROM inventory_reservations WHERE workspace_id=ws AND id=rid;
  IF remaining IS NULL THEN RETURN NULL; END IF;
  SELECT COALESCE(sum(quantity),0) INTO allocated FROM inventory_reservation_allocations WHERE workspace_id=ws AND reservation_id=rid;
  IF remaining<>allocated THEN RAISE EXCEPTION 'RESERVATION_QUANTITY_INVALID' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER inventory_reservation_allocation_total AFTER INSERT OR UPDATE ON inventory_reservations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inventory_reservation_allocation_total_guard();
CREATE CONSTRAINT TRIGGER inventory_reservation_leg_total AFTER INSERT OR UPDATE OR DELETE ON inventory_reservation_allocations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inventory_reservation_allocation_total_guard();

CREATE FUNCTION inventory_reservation_fulfillment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE capacity numeric; used numeric;
BEGIN
  IF NEW.action<>'FULFILLED' THEN RETURN NEW; END IF;
  SELECT l.quantity INTO capacity FROM inventory_document_lines l
    JOIN inventory_documents d ON d.workspace_id=l.workspace_id AND d.id=l.document_id
    JOIN inventory_reservations r ON r.workspace_id=l.workspace_id AND r.id=NEW.reservation_id
    WHERE l.workspace_id=NEW.workspace_id AND l.id=NEW.document_line_id AND l.inventory_key=r.inventory_key
      AND d.document_type='SALES_ORDER' AND d.status='PROCESSED' AND d.reversed_at IS NULL
      AND (r.source_type='MANUAL' OR (d.source_entity_type=r.source_type AND d.source_entity_id=r.source_id))
      AND EXISTS (SELECT 1 FROM inventory_movements m WHERE m.workspace_id=l.workspace_id AND m.document_line_id=l.id
        AND m.warehouse_id=d.source_warehouse_id AND m.quantity_delta=-l.quantity AND m.reverses_movement_id IS NULL);
  SELECT COALESCE(sum(quantity),0) INTO used FROM inventory_reservation_history
    WHERE workspace_id=NEW.workspace_id AND document_line_id=NEW.document_line_id AND action='FULFILLED';
  IF capacity IS NULL OR used>capacity OR NEW.quantity<=0 THEN RAISE EXCEPTION 'RESERVATION_SOURCE_INVALID' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER inventory_reservation_fulfillment AFTER INSERT ON inventory_reservation_history
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inventory_reservation_fulfillment_guard();

CREATE FUNCTION inventory_document_location_owner_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM inventory_documents d WHERE d.workspace_id=NEW.workspace_id AND d.id=NEW.document_id
    AND (NEW.source_location_id IS NULL OR EXISTS (SELECT 1 FROM inventory_locations l WHERE l.workspace_id=d.workspace_id
      AND l.id=NEW.source_location_id AND l.warehouse_id=d.source_warehouse_id))
    AND (NEW.target_location_id IS NULL OR EXISTS (SELECT 1 FROM inventory_locations l WHERE l.workspace_id=d.workspace_id
      AND l.id=NEW.target_location_id AND l.warehouse_id=d.destination_warehouse_id)))
    THEN RAISE EXCEPTION 'INVENTORY_LINE_INVALID' USING ERRCODE='23503'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inventory_document_location_owner BEFORE INSERT OR UPDATE OF source_location_id,target_location_id,document_id
  ON inventory_document_lines FOR EACH ROW EXECUTE FUNCTION inventory_document_location_owner_guard();

CREATE FUNCTION inventory_layer_origin_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM inventory_movements m WHERE m.workspace_id=NEW.workspace_id AND m.id=NEW.source_movement_id
    AND m.document_line_id=NEW.source_document_line_id AND m.warehouse_id=NEW.warehouse_id AND m.inventory_key=NEW.inventory_key
    AND m.currency=NEW.currency AND m.quantity_delta>0 AND m.valuation_generation=NEW.generation)
    THEN RAISE EXCEPTION 'COSTING_RECONCILIATION_FAILED' USING ERRCODE='23503'; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER inventory_layer_origin AFTER INSERT ON inventory_cost_layers
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inventory_layer_origin_guard();
