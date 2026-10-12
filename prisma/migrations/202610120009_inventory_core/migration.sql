-- CreateTable
CREATE TABLE "inventory_warehouses" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "warehouse_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "timezone" TEXT NOT NULL,
    "address_id" UUID,
    "phone" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "region_code" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "version" BIGINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inventory_warehouses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_locations" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "parent_location_id" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "version" BIGINT NOT NULL DEFAULT 1,

    CONSTRAINT "inventory_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_warehouse_permissions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "scope" TEXT NOT NULL,

    CONSTRAINT "inventory_warehouse_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_settings" (
    "workspace_id" UUID NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "costing_method" TEXT NOT NULL DEFAULT 'FIFO',
    "costing_locked" BOOLEAN NOT NULL DEFAULT false,
    "allow_negative_stock" BOOLEAN NOT NULL DEFAULT false,
    "allow_backorder_reservations" BOOLEAN NOT NULL DEFAULT false,
    "default_reservation_days" INTEGER NOT NULL DEFAULT 3,
    "default_warehouse_id" UUID,
    "default_allocation_strategy" TEXT NOT NULL DEFAULT 'DEFAULT_WAREHOUSE',
    "approval_policies" JSONB NOT NULL DEFAULT '{}',
    "version" BIGINT NOT NULL DEFAULT 1,

    CONSTRAINT "inventory_settings_pkey" PRIMARY KEY ("workspace_id")
);

-- CreateTable
CREATE TABLE "inventory_balances" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "inventory_key" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "variant_id" UUID,
    "location_id" UUID,
    "location_key" TEXT NOT NULL DEFAULT '',
    "on_hand" DECIMAL(24,6) NOT NULL DEFAULT 0,
    "reserved" DECIMAL(24,6) NOT NULL DEFAULT 0,
    "version" BIGINT NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inventory_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_documents" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "document_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "source_warehouse_id" UUID,
    "destination_warehouse_id" UUID,
    "currency" CHAR(3) NOT NULL,
    "source_entity_type" TEXT,
    "source_entity_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "processed_by_user_id" UUID,
    "processed_at" TIMESTAMPTZ(6),
    "reversed_at" TIMESTAMPTZ(6),
    "reversal_reason" TEXT,
    "approval_revision" BIGINT,
    "version" BIGINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inventory_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_document_lines" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "variant_id" UUID,
    "inventory_key" UUID NOT NULL,
    "quantity" DECIMAL(24,6) NOT NULL,
    "unit_cost" DECIMAL(24,6) NOT NULL,
    "adjustment_direction" TEXT,
    "source_location_id" UUID,
    "target_location_id" UUID,
    "write_off_reason" TEXT,
    "reservation_id" UUID,
    "line_number" INTEGER NOT NULL,
    "version" BIGINT NOT NULL DEFAULT 1,

    CONSTRAINT "inventory_document_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_document_history" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_document_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_movements" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "location_id" UUID,
    "product_id" UUID NOT NULL,
    "variant_id" UUID,
    "inventory_key" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "document_line_id" UUID NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" UUID NOT NULL,
    "quantity_delta" DECIMAL(24,6) NOT NULL,
    "unit_cost" DECIMAL(24,6) NOT NULL,
    "total_cost" DECIMAL(24,6) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "movement_type" TEXT NOT NULL,
    "posting_key" TEXT NOT NULL,
    "reverses_movement_id" UUID,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_reservations" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "variant_id" UUID,
    "inventory_key" UUID NOT NULL,
    "quantity" DECIMAL(24,6) NOT NULL,
    "fulfilled_quantity" DECIMAL(24,6) NOT NULL DEFAULT 0,
    "released_quantity" DECIMAL(24,6) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_by_user_id" UUID NOT NULL,
    "reserved_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "version" BIGINT NOT NULL DEFAULT 1,

    CONSTRAINT "inventory_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_reservation_allocations" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "reservation_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "location_id" UUID,
    "location_key" TEXT NOT NULL DEFAULT '',
    "quantity" DECIMAL(24,6) NOT NULL,

    CONSTRAINT "inventory_reservation_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_reservation_history" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "reservation_id" UUID NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "quantity" DECIMAL(24,6) NOT NULL,
    "document_line_id" UUID,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_reservation_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stocktake_sessions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "location_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "as_of_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_by_user_id" UUID NOT NULL,
    "completed_by_user_id" UUID,
    "version" BIGINT NOT NULL DEFAULT 1,

    CONSTRAINT "stocktake_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_warehouses_workspace_id_status_priority_idx" ON "inventory_warehouses"("workspace_id", "status", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_warehouses_workspace_id_id_key" ON "inventory_warehouses"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_warehouses_workspace_id_code_key" ON "inventory_warehouses"("workspace_id", "code");

-- CreateIndex
CREATE INDEX "inventory_locations_workspace_id_warehouse_id_status_idx" ON "inventory_locations"("workspace_id", "warehouse_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_locations_workspace_id_id_key" ON "inventory_locations"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_locations_workspace_id_warehouse_id_id_key" ON "inventory_locations"("workspace_id", "warehouse_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_locations_warehouse_id_parent_location_id_code_key" ON "inventory_locations"("warehouse_id", "parent_location_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_warehouse_permissions_workspace_id_warehouse_id_r_key" ON "inventory_warehouse_permissions"("workspace_id", "warehouse_id", "role_id", "action");

-- CreateIndex
CREATE INDEX "inventory_balances_workspace_id_product_id_warehouse_id_idx" ON "inventory_balances"("workspace_id", "product_id", "warehouse_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_balances_workspace_id_id_key" ON "inventory_balances"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_balances_workspace_id_warehouse_id_inventory_key__key" ON "inventory_balances"("workspace_id", "warehouse_id", "inventory_key", "location_key");

-- CreateIndex
CREATE INDEX "inventory_documents_workspace_id_status_document_type_idx" ON "inventory_documents"("workspace_id", "status", "document_type");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_documents_workspace_id_id_key" ON "inventory_documents"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_documents_workspace_id_number_key" ON "inventory_documents"("workspace_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_document_lines_workspace_id_id_key" ON "inventory_document_lines"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_document_lines_workspace_id_document_id_id_key" ON "inventory_document_lines"("workspace_id", "document_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_document_lines_workspace_id_document_id_line_numb_key" ON "inventory_document_lines"("workspace_id", "document_id", "line_number");

-- CreateIndex
CREATE INDEX "inventory_document_history_workspace_id_document_id_occurre_idx" ON "inventory_document_history"("workspace_id", "document_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_document_history_workspace_id_id_key" ON "inventory_document_history"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "inventory_movements_workspace_id_warehouse_id_inventory_key_idx" ON "inventory_movements"("workspace_id", "warehouse_id", "inventory_key", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_movements_workspace_id_id_key" ON "inventory_movements"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_movements_workspace_id_posting_key_key" ON "inventory_movements"("workspace_id", "posting_key");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_movements_workspace_id_reverses_movement_id_key" ON "inventory_movements"("workspace_id", "reverses_movement_id");

-- CreateIndex
CREATE INDEX "inventory_reservations_status_expires_at_idx" ON "inventory_reservations"("status", "expires_at");

-- CreateIndex
CREATE INDEX "inventory_reservations_workspace_id_source_type_source_id_idx" ON "inventory_reservations"("workspace_id", "source_type", "source_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_reservations_workspace_id_id_key" ON "inventory_reservations"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_reservation_allocations_workspace_id_id_key" ON "inventory_reservation_allocations"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_reservation_allocations_workspace_id_reservation__key" ON "inventory_reservation_allocations"("workspace_id", "reservation_id", "warehouse_id", "location_key");

-- CreateIndex
CREATE INDEX "inventory_reservation_history_workspace_id_reservation_id_o_idx" ON "inventory_reservation_history"("workspace_id", "reservation_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_reservation_history_workspace_id_id_key" ON "inventory_reservation_history"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "stocktake_sessions_workspace_id_warehouse_id_status_idx" ON "stocktake_sessions"("workspace_id", "warehouse_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "stocktake_sessions_workspace_id_id_key" ON "stocktake_sessions"("workspace_id", "id");

-- Additive tenant guards and ledger integrity; no existing business row is rewritten.
CREATE UNIQUE INDEX IF NOT EXISTS inventory_catalog_tenant_identity ON catalog_products(workspace_id,id);
CREATE UNIQUE INDEX inventory_active_default_warehouse ON inventory_warehouses(workspace_id) WHERE is_default AND status='ACTIVE';
CREATE UNIQUE INDEX inventory_root_location_code ON inventory_locations(workspace_id,warehouse_id,code) WHERE parent_location_id IS NULL;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['inventory_warehouses','inventory_locations','inventory_warehouse_permissions','inventory_settings','inventory_balances',
    'inventory_documents','inventory_document_lines','inventory_document_history','inventory_movements','inventory_reservations',
    'inventory_reservation_allocations','inventory_reservation_history','stocktake_sessions'] LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT',t,t||'_workspace_fk');
  END LOOP;
  FOREACH t IN ARRAY ARRAY['inventory_locations','inventory_warehouse_permissions','inventory_balances','inventory_movements','inventory_reservations',
    'inventory_reservation_allocations','stocktake_sessions'] LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (workspace_id,warehouse_id) REFERENCES inventory_warehouses(workspace_id,id) ON DELETE RESTRICT',t,t||'_warehouse_fk');
  END LOOP;
  FOREACH t IN ARRAY ARRAY['inventory_balances','inventory_document_lines','inventory_movements','inventory_reservations'] LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (workspace_id,product_id) REFERENCES catalog_products(workspace_id,id) ON DELETE RESTRICT',t,t||'_product_fk');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (workspace_id,variant_id) REFERENCES catalog_products(workspace_id,id) ON DELETE RESTRICT',t,t||'_variant_fk');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (inventory_key=COALESCE(variant_id,product_id))',t,t||'_inventory_key_ck');
  END LOOP;
  FOREACH t IN ARRAY ARRAY['inventory_balances','inventory_movements','inventory_reservation_allocations','stocktake_sessions'] LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (workspace_id,warehouse_id,location_id) REFERENCES inventory_locations(workspace_id,warehouse_id,id) ON DELETE RESTRICT',t,t||'_location_fk');
  END LOOP;
END $$;
ALTER TABLE inventory_warehouses
  ADD CONSTRAINT inventory_warehouse_creator_fk FOREIGN KEY (workspace_id,created_by_user_id) REFERENCES workspace_memberships(workspace_id,user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT inventory_warehouse_shape_ck CHECK (version>0 AND priority>=0 AND code ~ '^[A-Z][A-Z0-9_]{1,63}$'
    AND status IN ('ACTIVE','INACTIVE','ARCHIVED') AND warehouse_type IN ('PHYSICAL','STORE','FULFILLMENT','RETURNS','DAMAGED','TRANSIT','VIRTUAL') AND (NOT is_default OR status='ACTIVE'));
ALTER TABLE inventory_locations
  ADD CONSTRAINT inventory_location_parent_fk FOREIGN KEY (workspace_id,warehouse_id,parent_location_id) REFERENCES inventory_locations(workspace_id,warehouse_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT inventory_location_shape_ck CHECK (version>0 AND parent_location_id IS DISTINCT FROM id AND type IN ('AISLE','RACK','BIN','ZONE') AND status IN ('ACTIVE','INACTIVE'));
ALTER TABLE inventory_warehouse_permissions
  ADD CONSTRAINT inventory_warehouse_role_fk FOREIGN KEY (workspace_id,role_id) REFERENCES roles(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT inventory_warehouse_permission_ck CHECK (action LIKE 'INVENTORY.%' AND scope IN ('NONE','OWN','DEPARTMENT','DEPARTMENT_TREE','ALL'));
ALTER TABLE inventory_settings
  ADD CONSTRAINT inventory_default_warehouse_fk FOREIGN KEY (workspace_id,default_warehouse_id) REFERENCES inventory_warehouses(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT inventory_settings_shape_ck CHECK (version>0 AND default_reservation_days BETWEEN 1 AND 365 AND costing_method IN ('FIFO','AVERAGE')
    AND default_allocation_strategy IN ('DEFAULT_WAREHOUSE','MOST_AVAILABLE','PRIORITY_LIST','MANUAL'));
ALTER TABLE inventory_balances ADD CONSTRAINT inventory_balance_shape_ck CHECK (version>0 AND reserved>=0 AND location_key=COALESCE(location_id::text,''));
ALTER TABLE inventory_documents
  ADD CONSTRAINT inventory_document_source_warehouse_fk FOREIGN KEY (workspace_id,source_warehouse_id) REFERENCES inventory_warehouses(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT inventory_document_dest_warehouse_fk FOREIGN KEY (workspace_id,destination_warehouse_id) REFERENCES inventory_warehouses(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT inventory_document_creator_fk FOREIGN KEY (workspace_id,created_by_user_id) REFERENCES workspace_memberships(workspace_id,user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT inventory_document_processor_fk FOREIGN KEY (workspace_id,processed_by_user_id) REFERENCES workspace_memberships(workspace_id,user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT inventory_document_shape_ck CHECK (version>0 AND currency ~ '^[A-Z]{3}$' AND status IN ('DRAFT','PENDING_APPROVAL','APPROVED','PROCESSED','CANCELLED')
    AND document_type IN ('STOCK_RECEIPT','STOCK_ADJUSTMENT','TRANSFER','SALES_ORDER','CUSTOMER_RETURN','SUPPLIER_RETURN','WRITE_OFF')
    AND (document_type<>'TRANSFER' OR source_warehouse_id IS NOT NULL AND destination_warehouse_id IS NOT NULL AND source_warehouse_id<>destination_warehouse_id)
    AND (source_entity_type IS NULL)=(source_entity_id IS NULL) AND (processed_at IS NULL)=(processed_by_user_id IS NULL));
ALTER TABLE inventory_document_lines
  ADD CONSTRAINT inventory_line_document_fk FOREIGN KEY (workspace_id,document_id) REFERENCES inventory_documents(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT inventory_line_reservation_fk FOREIGN KEY (workspace_id,reservation_id) REFERENCES inventory_reservations(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT inventory_line_source_location_fk FOREIGN KEY (workspace_id,source_location_id) REFERENCES inventory_locations(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT inventory_line_target_location_fk FOREIGN KEY (workspace_id,target_location_id) REFERENCES inventory_locations(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT inventory_line_shape_ck CHECK (version>0 AND quantity>0 AND unit_cost>=0 AND line_number>0 AND (adjustment_direction IS NULL OR adjustment_direction IN ('IN','OUT')));
ALTER TABLE inventory_document_history
  ADD CONSTRAINT inventory_history_document_fk FOREIGN KEY (workspace_id,document_id) REFERENCES inventory_documents(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT inventory_history_actor_fk FOREIGN KEY (workspace_id,actor_user_id) REFERENCES workspace_memberships(workspace_id,user_id) ON DELETE RESTRICT;
ALTER TABLE inventory_movements
  ADD CONSTRAINT inventory_movement_line_fk FOREIGN KEY (workspace_id,document_id,document_line_id) REFERENCES inventory_document_lines(workspace_id,document_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT inventory_movement_reverse_fk FOREIGN KEY (workspace_id,reverses_movement_id) REFERENCES inventory_movements(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT inventory_movement_shape_ck CHECK (quantity_delta<>0 AND unit_cost>=0 AND currency ~ '^[A-Z]{3}$'
    AND (total_cost=0 OR sign(total_cost)=sign(quantity_delta)) AND abs(total_cost-round(quantity_delta*unit_cost,6))<=abs(quantity_delta)*0.0000005+0.0000005);
ALTER TABLE inventory_reservations
  ADD CONSTRAINT inventory_reservation_creator_fk FOREIGN KEY (workspace_id,created_by_user_id) REFERENCES workspace_memberships(workspace_id,user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT inventory_reservation_shape_ck CHECK (version>0 AND quantity>0 AND fulfilled_quantity>=0 AND released_quantity>=0
    AND fulfilled_quantity+released_quantity<=quantity AND expires_at>reserved_at AND source_type IN ('DEAL','ORDER','INVOICE','MANUAL','SPA_ITEM')
    AND status IN ('ACTIVE','PARTIALLY_FULFILLED','FULFILLED','RELEASED','EXPIRED','CANCELLED'));
ALTER TABLE inventory_reservation_allocations
  ADD CONSTRAINT inventory_allocation_reservation_fk FOREIGN KEY (workspace_id,reservation_id) REFERENCES inventory_reservations(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT inventory_allocation_shape_ck CHECK (quantity>=0 AND location_key=COALESCE(location_id::text,''));
ALTER TABLE inventory_reservation_history
  ADD CONSTRAINT inventory_res_history_owner_fk FOREIGN KEY (workspace_id,reservation_id) REFERENCES inventory_reservations(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT inventory_res_history_actor_fk FOREIGN KEY (workspace_id,actor_user_id) REFERENCES workspace_memberships(workspace_id,user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT inventory_res_history_line_fk FOREIGN KEY (workspace_id,document_line_id) REFERENCES inventory_document_lines(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT inventory_res_history_quantity_ck CHECK (quantity>=0);
ALTER TABLE stocktake_sessions
  ADD CONSTRAINT inventory_stocktake_starter_fk FOREIGN KEY (workspace_id,started_by_user_id) REFERENCES workspace_memberships(workspace_id,user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT inventory_stocktake_completer_fk FOREIGN KEY (workspace_id,completed_by_user_id) REFERENCES workspace_memberships(workspace_id,user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT inventory_stocktake_shape_ck CHECK (version>0 AND status IN ('DRAFT','COUNTING','RECONCILING','POSTED','CANCELLED'));
CREATE FUNCTION inventory_reject_evidence_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'STOCK_LEDGER_IMMUTABLE'; END $$;
CREATE TRIGGER inventory_movement_immutable BEFORE UPDATE OR DELETE ON inventory_movements FOR EACH ROW EXECUTE FUNCTION inventory_reject_evidence_change();
CREATE TRIGGER inventory_doc_history_immutable BEFORE UPDATE OR DELETE ON inventory_document_history FOR EACH ROW EXECUTE FUNCTION inventory_reject_evidence_change();
CREATE TRIGGER inventory_res_history_immutable BEFORE UPDATE OR DELETE ON inventory_reservation_history FOR EACH ROW EXECUTE FUNCTION inventory_reject_evidence_change();
CREATE FUNCTION inventory_location_cycle_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE found_cycle boolean; BEGIN
  IF NEW.parent_location_id IS NULL THEN RETURN NEW; END IF;
  WITH RECURSIVE parents AS (
    SELECT id,parent_location_id,ARRAY[id] AS visited,false AS cycle FROM inventory_locations WHERE workspace_id=NEW.workspace_id AND warehouse_id=NEW.warehouse_id AND id=NEW.parent_location_id
    UNION ALL
    SELECT l.id,l.parent_location_id,p.visited||l.id,l.id=ANY(p.visited) FROM inventory_locations l JOIN parents p ON l.id=p.parent_location_id
      WHERE l.workspace_id=NEW.workspace_id AND l.warehouse_id=NEW.warehouse_id AND NOT p.cycle
  ) SELECT COALESCE(bool_or(id=NEW.id OR cycle),false) INTO found_cycle FROM parents;
  IF found_cycle THEN RAISE EXCEPTION 'LOCATION_CYCLE'; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION inventory_processed_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_status text; owner_workspace uuid; owner_document uuid; BEGIN
  IF TG_OP='DELETE' THEN owner_workspace=OLD.workspace_id; owner_document=OLD.document_id;
  ELSE owner_workspace=NEW.workspace_id; owner_document=NEW.document_id; END IF;
  SELECT status INTO owner_status FROM inventory_documents WHERE workspace_id=owner_workspace AND id=owner_document FOR SHARE;
  IF owner_status='PROCESSED' THEN RAISE EXCEPTION 'INVENTORY_DOCUMENT_NOT_DRAFT'; END IF;
  IF TG_OP='UPDATE' AND (NEW.workspace_id,NEW.document_id) IS DISTINCT FROM (OLD.workspace_id,OLD.document_id) THEN
    RAISE EXCEPTION 'INVENTORY_LINE_INVALID';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inventory_processed_line BEFORE INSERT OR UPDATE OR DELETE ON inventory_document_lines FOR EACH ROW EXECUTE FUNCTION inventory_processed_line_guard();
CREATE FUNCTION inventory_movement_document_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM inventory_documents d JOIN inventory_document_lines l ON l.workspace_id=d.workspace_id AND l.document_id=d.id
    WHERE d.workspace_id=NEW.workspace_id AND d.id=NEW.document_id AND l.id=NEW.document_line_id AND d.status='PROCESSED'
      AND l.product_id=NEW.product_id AND l.variant_id IS NOT DISTINCT FROM NEW.variant_id AND d.currency=NEW.currency
      AND NEW.warehouse_id IN (d.source_warehouse_id,d.destination_warehouse_id)) THEN
    RAISE EXCEPTION 'INVENTORY_LINE_INVALID' USING ERRCODE='23503';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER inventory_movement_document AFTER INSERT ON inventory_movements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inventory_movement_document_guard();
CREATE FUNCTION inventory_processed_document_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.status='PROCESSED' THEN RAISE EXCEPTION 'INVENTORY_DOCUMENT_ALREADY_PROCESSED'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status='PROCESSED' AND (to_jsonb(OLD)-ARRAY['reversed_at','reversal_reason','version','updated_at'])
    IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['reversed_at','reversal_reason','version','updated_at']) THEN
    RAISE EXCEPTION 'INVENTORY_DOCUMENT_ALREADY_PROCESSED';
  END IF;
  IF OLD.reversed_at IS NOT NULL AND (NEW.reversed_at,NEW.reversal_reason) IS DISTINCT FROM (OLD.reversed_at,OLD.reversal_reason) THEN
    RAISE EXCEPTION 'INVENTORY_DOCUMENT_ALREADY_PROCESSED';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inventory_processed_document BEFORE UPDATE OR DELETE ON inventory_documents FOR EACH ROW EXECUTE FUNCTION inventory_processed_document_guard();
CREATE TRIGGER inventory_location_cycle BEFORE INSERT OR UPDATE OF parent_location_id ON inventory_locations FOR EACH ROW EXECUTE FUNCTION inventory_location_cycle_guard();
CREATE FUNCTION inventory_sku_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.variant_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM catalog_products p JOIN catalog_products v ON v.parent_id=p.id AND v.workspace_id=p.workspace_id
      WHERE p.id=NEW.product_id AND v.id=NEW.variant_id AND p.workspace_id=NEW.workspace_id AND p.type='PRODUCT_WITH_VARIANTS' AND v.type='VARIANT') THEN
      RAISE EXCEPTION 'INVENTORY_LINE_INVALID' USING ERRCODE='23503';
    END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM catalog_products WHERE workspace_id=NEW.workspace_id AND id=NEW.product_id AND type='SIMPLE_PRODUCT') THEN
    RAISE EXCEPTION 'STOCK_SERVICE_NOT_TRACKABLE' USING ERRCODE='23503';
  END IF;
  RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['inventory_balances','inventory_document_lines','inventory_movements','inventory_reservations'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OF product_id,variant_id,inventory_key ON %I FOR EACH ROW EXECUTE FUNCTION inventory_sku_guard()',t||'_sku_guard',t);
  END LOOP;
END $$;
