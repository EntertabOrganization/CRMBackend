-- CreateTable
CREATE TABLE "commerce_order_payment_bindings" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "amount" DECIMAL(24,6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_order_payment_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_delivery_services" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "provider_connection_id" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "conditions" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_delivery_services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_delivery_rates" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "conditions" JSONB NOT NULL DEFAULT '{}',
    "price" DECIMAL(24,6) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "estimated_days_min" INTEGER NOT NULL,
    "estimated_days_max" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "commerce_delivery_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_shipments" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "delivery_service_id" UUID NOT NULL,
    "inventory_document_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "tracking_number" TEXT,
    "external_shipment_id" TEXT,
    "shipped_at" TIMESTAMPTZ(6),
    "delivered_at" TIMESTAMPTZ(6),
    "version" BIGINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_shipment_items" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "order_line_id" UUID NOT NULL,
    "quantity" DECIMAL(18,6) NOT NULL,

    CONSTRAINT "commerce_shipment_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_shipment_stock_bindings" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "reservation_id" UUID NOT NULL,
    "location_id" UUID,
    "quantity" DECIMAL(18,6) NOT NULL,
    "inventory_document_line_id" UUID,

    CONSTRAINT "commerce_shipment_stock_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_shipment_events" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "actor_user_id" UUID,
    "action" TEXT NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_shipment_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "commerce_order_payment_bindings_workspace_id_payment_id_idx" ON "commerce_order_payment_bindings"("workspace_id", "payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_order_payment_bindings_order_id_payment_id_key" ON "commerce_order_payment_bindings"("order_id", "payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_delivery_services_workspace_id_store_id_id_key" ON "commerce_delivery_services"("workspace_id", "store_id", "id");

-- CreateIndex
CREATE INDEX "commerce_delivery_rates_workspace_id_service_id_idx" ON "commerce_delivery_rates"("workspace_id", "service_id");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_delivery_rates_workspace_id_store_id_id_key" ON "commerce_delivery_rates"("workspace_id", "store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_shipments_inventory_document_id_key" ON "commerce_shipments"("inventory_document_id");

-- CreateIndex
CREATE INDEX "commerce_shipments_workspace_id_order_id_status_idx" ON "commerce_shipments"("workspace_id", "order_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_shipments_workspace_id_store_id_id_key" ON "commerce_shipments"("workspace_id", "store_id", "id");

-- CreateIndex
CREATE INDEX "commerce_shipment_items_workspace_id_order_id_order_line_id_idx" ON "commerce_shipment_items"("workspace_id", "order_id", "order_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_shipment_items_shipment_id_order_line_id_key" ON "commerce_shipment_items"("shipment_id", "order_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_shipment_items_workspace_id_id_key" ON "commerce_shipment_items"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_shipment_stock_bindings_inventory_document_line_id_key" ON "commerce_shipment_stock_bindings"("inventory_document_line_id");

-- CreateIndex
CREATE INDEX "commerce_shipment_stock_bindings_workspace_id_reservation_i_idx" ON "commerce_shipment_stock_bindings"("workspace_id", "reservation_id", "location_id");

-- CreateIndex
CREATE INDEX "commerce_shipment_events_workspace_id_shipment_id_occurred__idx" ON "commerce_shipment_events"("workspace_id", "shipment_id", "occurred_at");

ALTER TABLE commerce_delivery_services ADD CONSTRAINT delivery_store_fk FOREIGN KEY(workspace_id,store_id) REFERENCES commerce_stores(workspace_id,id) ON DELETE RESTRICT;
ALTER TABLE commerce_delivery_services ADD CONSTRAINT delivery_connection_fk FOREIGN KEY(workspace_id,provider_connection_id) REFERENCES integration_outbound_connections(workspace_id,id) ON DELETE RESTRICT;
ALTER TABLE commerce_delivery_services ADD CONSTRAINT delivery_type_check CHECK(type IN ('COURIER','PICKUP','POSTAL','SAME_DAY','THIRD_PARTY','DIGITAL','CUSTOM'));
ALTER TABLE commerce_delivery_rates ADD CONSTRAINT delivery_rate_service_fk FOREIGN KEY(workspace_id,store_id,service_id) REFERENCES commerce_delivery_services(workspace_id,store_id,id) ON DELETE RESTRICT;
ALTER TABLE commerce_delivery_rates ADD CONSTRAINT delivery_rate_check CHECK(price>=0 AND estimated_days_min>=0 AND estimated_days_max>=estimated_days_min);
ALTER TABLE commerce_shipments ADD CONSTRAINT shipment_order_fk FOREIGN KEY(workspace_id,store_id,order_id) REFERENCES commerce_orders(workspace_id,store_id,id) ON DELETE RESTRICT;
ALTER TABLE commerce_shipments ADD CONSTRAINT shipment_warehouse_fk FOREIGN KEY(workspace_id,warehouse_id) REFERENCES inventory_warehouses(workspace_id,id) ON DELETE RESTRICT;
ALTER TABLE commerce_shipments ADD CONSTRAINT shipment_service_fk FOREIGN KEY(workspace_id,store_id,delivery_service_id) REFERENCES commerce_delivery_services(workspace_id,store_id,id) ON DELETE RESTRICT;
ALTER TABLE commerce_shipments ADD CONSTRAINT shipment_document_fk FOREIGN KEY(workspace_id,inventory_document_id) REFERENCES inventory_documents(workspace_id,id) ON DELETE RESTRICT;
ALTER TABLE commerce_shipments ADD CONSTRAINT shipment_status_check CHECK(version>0 AND status IN ('NEW','PROCESSING','READY','SHIPPED','IN_TRANSIT','DELIVERED','FAILED','RETURNED','CANCELLED')
  AND (status NOT IN ('SHIPPED','IN_TRANSIT','DELIVERED','RETURNED') OR shipped_at IS NOT NULL) AND (status!='DELIVERED' OR delivered_at>=shipped_at));
ALTER TABLE commerce_shipment_items ADD CONSTRAINT shipment_item_parent_fk FOREIGN KEY(workspace_id,store_id,shipment_id) REFERENCES commerce_shipments(workspace_id,store_id,id) ON DELETE RESTRICT;
ALTER TABLE commerce_shipment_items ADD CONSTRAINT shipment_item_quantity_check CHECK(quantity>0);
ALTER TABLE commerce_shipment_stock_bindings ADD CONSTRAINT shipment_binding_item_fk FOREIGN KEY(workspace_id,item_id) REFERENCES commerce_shipment_items(workspace_id,id) ON DELETE RESTRICT;
ALTER TABLE commerce_shipment_stock_bindings ADD CONSTRAINT shipment_binding_reservation_fk FOREIGN KEY(workspace_id,reservation_id) REFERENCES inventory_reservations(workspace_id,id) ON DELETE RESTRICT;
ALTER TABLE commerce_shipment_stock_bindings ADD CONSTRAINT shipment_binding_line_fk FOREIGN KEY(workspace_id,inventory_document_line_id) REFERENCES inventory_document_lines(workspace_id,id) ON DELETE RESTRICT;
ALTER TABLE commerce_shipment_stock_bindings ADD CONSTRAINT shipment_binding_quantity_check CHECK(quantity>0);
ALTER TABLE commerce_shipment_events ADD CONSTRAINT shipment_event_parent_fk FOREIGN KEY(workspace_id,store_id,shipment_id) REFERENCES commerce_shipments(workspace_id,store_id,id) ON DELETE RESTRICT;
ALTER TABLE commerce_shipment_events ADD CONSTRAINT shipment_event_actor_fk FOREIGN KEY(workspace_id,actor_user_id) REFERENCES workspace_memberships(workspace_id,user_id) ON DELETE RESTRICT;
ALTER TABLE commerce_order_payment_bindings ADD CONSTRAINT order_payment_order_fk FOREIGN KEY(workspace_id,store_id,order_id) REFERENCES commerce_orders(workspace_id,store_id,id) ON DELETE RESTRICT;
ALTER TABLE commerce_order_payment_bindings ADD CONSTRAINT order_payment_record_fk FOREIGN KEY(payment_id) REFERENCES commercial_pack_records(id) ON DELETE RESTRICT;
ALTER TABLE commerce_order_payment_bindings ADD CONSTRAINT order_payment_amount_check CHECK(amount>0);
CREATE FUNCTION commerce_order_payment_owner_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM commercial_pack_records p WHERE p.workspace_id=NEW.workspace_id AND p.id=NEW.payment_id AND p.collection='payments')
  THEN RAISE EXCEPTION 'SHIPMENT_PAYMENT_BLOCKED' USING ERRCODE='23503'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commerce_order_payment_owner BEFORE INSERT OR UPDATE ON commerce_order_payment_bindings FOR EACH ROW EXECUTE FUNCTION commerce_order_payment_owner_guard();
CREATE FUNCTION commerce_shipment_item_owner_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM commerce_shipments s JOIN commerce_orders o ON o.workspace_id=s.workspace_id AND o.id=s.order_id
    WHERE s.workspace_id=NEW.workspace_id AND s.id=NEW.shipment_id AND s.order_id=NEW.order_id AND s.store_id=NEW.store_id
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(o.snapshot->'lines') l WHERE l->>'itemId'=NEW.order_line_id::text))
  THEN RAISE EXCEPTION 'SHIPMENT_QUANTITY_EXCEEDED' USING ERRCODE='23503'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commerce_shipment_item_owner BEFORE INSERT ON commerce_shipment_items FOR EACH ROW EXECUTE FUNCTION commerce_shipment_item_owner_guard();
CREATE FUNCTION commerce_shipment_quantity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ws uuid; oid uuid;
BEGIN
  IF TG_TABLE_NAME='commerce_shipments' THEN ws:=NEW.workspace_id; oid:=NEW.order_id;
  ELSE ws:=NEW.workspace_id; oid:=NEW.order_id; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(ws::text||':commerce:order:'||oid::text,0));
  IF EXISTS (SELECT 1 FROM commerce_orders o CROSS JOIN LATERAL jsonb_array_elements(o.snapshot->'lines') l
    WHERE o.workspace_id=ws AND o.id=oid AND (SELECT COALESCE(sum(i.quantity),0) FROM commerce_shipment_items i
      JOIN commerce_shipments s ON s.workspace_id=i.workspace_id AND s.id=i.shipment_id
      WHERE i.workspace_id=ws AND i.order_id=oid AND i.order_line_id::text=l->>'itemId' AND s.status!='CANCELLED')>(l->>'quantity')::numeric)
  THEN RAISE EXCEPTION 'SHIPMENT_QUANTITY_EXCEEDED' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER commerce_shipment_quantity AFTER INSERT OR UPDATE ON commerce_shipments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commerce_shipment_quantity_guard();
CREATE CONSTRAINT TRIGGER commerce_shipment_item_quantity AFTER INSERT ON commerce_shipment_items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commerce_shipment_quantity_guard();
CREATE FUNCTION commerce_shipment_binding_owner_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM commerce_shipment_items i JOIN commerce_shipments s ON s.workspace_id=i.workspace_id AND s.id=i.shipment_id
    JOIN commerce_orders o ON o.workspace_id=i.workspace_id AND o.id=i.order_id
    JOIN inventory_reservations r ON r.workspace_id=i.workspace_id AND r.source_type='ORDER' AND r.source_id=i.order_id
    WHERE i.workspace_id=NEW.workspace_id AND i.id=NEW.item_id AND i.shipment_id=NEW.shipment_id AND r.id=NEW.reservation_id
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(o.snapshot->'lines') l WHERE l->>'itemId'=i.order_line_id::text AND l->>'inventoryKey'=r.inventory_key::text)
      AND (NEW.location_id IS NULL OR EXISTS (SELECT 1 FROM inventory_locations loc WHERE loc.workspace_id=s.workspace_id AND loc.id=NEW.location_id AND loc.warehouse_id=s.warehouse_id))
      AND (NEW.inventory_document_line_id IS NULL OR EXISTS (SELECT 1 FROM inventory_document_lines dl JOIN inventory_documents d ON d.workspace_id=dl.workspace_id AND d.id=dl.document_id
        WHERE dl.workspace_id=s.workspace_id AND dl.id=NEW.inventory_document_line_id AND dl.reservation_id=r.id AND dl.quantity=NEW.quantity
          AND dl.source_location_id IS NOT DISTINCT FROM NEW.location_id AND d.source_warehouse_id=s.warehouse_id AND d.source_entity_type='ORDER' AND d.source_entity_id=o.id)))
  THEN RAISE EXCEPTION 'SHIPMENT_INVENTORY_POST_FAILED' USING ERRCODE='23503'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commerce_shipment_binding_owner BEFORE INSERT OR UPDATE ON commerce_shipment_stock_bindings FOR EACH ROW EXECUTE FUNCTION commerce_shipment_binding_owner_guard();
CREATE FUNCTION commerce_shipment_dispatch_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'SHIPMENT_IMMUTABLE' USING ERRCODE='23514'; END IF;
  IF ROW(NEW.workspace_id,NEW.store_id,NEW.order_id,NEW.warehouse_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.workspace_id,OLD.store_id,OLD.order_id,OLD.warehouse_id,OLD.created_at)
  THEN RAISE EXCEPTION 'SHIPMENT_IMMUTABLE' USING ERRCODE='23514'; END IF;
  IF OLD.status IN ('SHIPPED','IN_TRANSIT','DELIVERED','RETURNED') AND
    (NEW.status IN ('NEW','PROCESSING','READY','CANCELLED') OR ROW(NEW.delivery_service_id,NEW.inventory_document_id,NEW.shipped_at) IS DISTINCT FROM ROW(OLD.delivery_service_id,OLD.inventory_document_id,OLD.shipped_at))
  THEN RAISE EXCEPTION 'SHIPMENT_INVALID_STATE' USING ERRCODE='23514'; END IF;
  IF NEW.status IN ('SHIPPED','IN_TRANSIT','DELIVERED') AND EXISTS (SELECT 1 FROM commerce_shipment_items i JOIN commerce_orders o ON o.workspace_id=i.workspace_id AND o.id=i.order_id
    CROSS JOIN LATERAL jsonb_array_elements(o.snapshot->'lines') l WHERE i.workspace_id=NEW.workspace_id AND i.shipment_id=NEW.id AND l->>'itemId'=i.order_line_id::text AND (l->>'stockable')::boolean)
    AND NOT EXISTS (SELECT 1 FROM inventory_documents d WHERE d.workspace_id=NEW.workspace_id AND d.id=NEW.inventory_document_id
      AND d.status='PROCESSED' AND d.reversed_at IS NULL AND d.document_type='SALES_ORDER' AND d.source_entity_type='ORDER' AND d.source_entity_id=NEW.order_id AND d.source_warehouse_id=NEW.warehouse_id)
  THEN RAISE EXCEPTION 'SHIPMENT_INVENTORY_POST_FAILED' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commerce_shipment_dispatch BEFORE UPDATE OR DELETE ON commerce_shipments FOR EACH ROW EXECUTE FUNCTION commerce_shipment_dispatch_guard();
CREATE TRIGGER commerce_shipment_item_immutable BEFORE UPDATE OR DELETE ON commerce_shipment_items FOR EACH ROW EXECUTE FUNCTION commerce_checkout_evidence_immutable();
CREATE TRIGGER commerce_shipment_event_immutable BEFORE UPDATE OR DELETE ON commerce_shipment_events FOR EACH ROW EXECUTE FUNCTION commerce_checkout_evidence_immutable();
CREATE FUNCTION commerce_shipment_binding_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'SHIPMENT_IMMUTABLE' USING ERRCODE='23514'; END IF;
  IF ROW(NEW.workspace_id,NEW.shipment_id,NEW.item_id,NEW.reservation_id,NEW.location_id,NEW.quantity)
    IS DISTINCT FROM ROW(OLD.workspace_id,OLD.shipment_id,OLD.item_id,OLD.reservation_id,OLD.location_id,OLD.quantity)
    OR (OLD.inventory_document_line_id IS NOT NULL AND NEW.inventory_document_line_id IS DISTINCT FROM OLD.inventory_document_line_id)
  THEN RAISE EXCEPTION 'SHIPMENT_IMMUTABLE' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commerce_shipment_binding_immutable BEFORE UPDATE OR DELETE ON commerce_shipment_stock_bindings FOR EACH ROW EXECUTE FUNCTION commerce_shipment_binding_immutable_guard();
CREATE FUNCTION commerce_shipment_stock_total_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ws uuid; iid uuid; requested numeric; allocated numeric; stockable boolean;
BEGIN
  ws:=NEW.workspace_id;
  IF TG_TABLE_NAME='commerce_shipment_items' THEN iid:=NEW.id; ELSE iid:=NEW.item_id; END IF;
  SELECT i.quantity,(l->>'stockable')::boolean INTO requested,stockable FROM commerce_shipment_items i
    JOIN commerce_orders o ON o.workspace_id=i.workspace_id AND o.id=i.order_id
    CROSS JOIN LATERAL jsonb_array_elements(o.snapshot->'lines') l
    WHERE i.workspace_id=ws AND i.id=iid AND l->>'itemId'=i.order_line_id::text;
  SELECT COALESCE(sum(quantity),0) INTO allocated FROM commerce_shipment_stock_bindings WHERE workspace_id=ws AND item_id=iid;
  IF (stockable AND allocated<>requested) OR (NOT stockable AND allocated<>0)
  THEN RAISE EXCEPTION 'SHIPMENT_INVENTORY_POST_FAILED' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER commerce_shipment_item_stock_total AFTER INSERT ON commerce_shipment_items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commerce_shipment_stock_total_guard();
CREATE CONSTRAINT TRIGGER commerce_shipment_binding_stock_total AFTER INSERT OR UPDATE ON commerce_shipment_stock_bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commerce_shipment_stock_total_guard();

