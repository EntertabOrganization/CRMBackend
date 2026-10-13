-- AlterTable
ALTER TABLE "commerce_shipments" ADD COLUMN     "last_provider_event_at" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "commerce_delivery_provider_events" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "provider_code" TEXT NOT NULL,
    "external_event_id" TEXT NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "normalized" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error_code" TEXT,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_delivery_provider_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "commerce_delivery_provider_events_status_next_attempt_at_re_idx" ON "commerce_delivery_provider_events"("status", "next_attempt_at", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_delivery_provider_events_workspace_id_connection_i_key" ON "commerce_delivery_provider_events"("workspace_id", "connection_id", "provider_code", "external_event_id");

ALTER TABLE commerce_delivery_provider_events ADD CONSTRAINT delivery_event_shipment_fk FOREIGN KEY(workspace_id,store_id,shipment_id) REFERENCES commerce_shipments(workspace_id,store_id,id) ON DELETE RESTRICT;
ALTER TABLE commerce_delivery_provider_events ADD CONSTRAINT delivery_event_connection_fk FOREIGN KEY(workspace_id,connection_id) REFERENCES integration_outbound_connections(workspace_id,id) ON DELETE RESTRICT;
ALTER TABLE commerce_delivery_provider_events ADD CONSTRAINT delivery_event_state_ck CHECK(status IN ('QUEUED','SUCCEEDED','FAILED') AND attempts BETWEEN 0 AND 5 AND payload_hash ~ '^[a-f0-9]{64}$' AND (status!='SUCCEEDED' OR processed_at IS NOT NULL));
CREATE FUNCTION commerce_delivery_event_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'DELIVERY_EVENT_IMMUTABLE' USING ERRCODE='23514'; END IF;
  IF ROW(NEW.workspace_id,NEW.store_id,NEW.connection_id,NEW.shipment_id,NEW.provider_code,NEW.external_event_id,NEW.payload_hash,NEW.normalized,NEW.received_at)
    IS DISTINCT FROM ROW(OLD.workspace_id,OLD.store_id,OLD.connection_id,OLD.shipment_id,OLD.provider_code,OLD.external_event_id,OLD.payload_hash,OLD.normalized,OLD.received_at)
    OR OLD.status IN ('SUCCEEDED','FAILED') OR NEW.attempts<OLD.attempts
  THEN RAISE EXCEPTION 'DELIVERY_EVENT_IMMUTABLE' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commerce_delivery_event_immutable BEFORE UPDATE OR DELETE ON commerce_delivery_provider_events FOR EACH ROW EXECUTE FUNCTION commerce_delivery_event_immutable_guard();
CREATE OR REPLACE FUNCTION commerce_shipment_dispatch_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'SHIPMENT_IMMUTABLE' USING ERRCODE='23514'; END IF;
  IF ROW(NEW.workspace_id,NEW.store_id,NEW.order_id,NEW.warehouse_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.workspace_id,OLD.store_id,OLD.order_id,OLD.warehouse_id,OLD.created_at)
  THEN RAISE EXCEPTION 'SHIPMENT_IMMUTABLE' USING ERRCODE='23514'; END IF;
  IF OLD.shipped_at IS NOT NULL AND (NEW.status IN ('NEW','PROCESSING','READY','CANCELLED')
    OR ROW(NEW.delivery_service_id,NEW.inventory_document_id,NEW.shipped_at) IS DISTINCT FROM ROW(OLD.delivery_service_id,OLD.inventory_document_id,OLD.shipped_at))
  THEN RAISE EXCEPTION 'SHIPMENT_INVALID_STATE' USING ERRCODE='23514'; END IF;
  IF OLD.last_provider_event_at IS NOT NULL AND (NEW.last_provider_event_at IS NULL OR NEW.last_provider_event_at<OLD.last_provider_event_at)
  THEN RAISE EXCEPTION 'DELIVERY_PROVIDER_REPLAY_CONFLICT' USING ERRCODE='23514'; END IF;
  IF NEW.status IN ('SHIPPED','IN_TRANSIT','DELIVERED') AND EXISTS (SELECT 1 FROM commerce_shipment_items i JOIN commerce_orders o ON o.workspace_id=i.workspace_id AND o.id=i.order_id
    CROSS JOIN LATERAL jsonb_array_elements(o.snapshot->'lines') l WHERE i.workspace_id=NEW.workspace_id AND i.shipment_id=NEW.id AND l->>'itemId'=i.order_line_id::text AND (l->>'stockable')::boolean)
    AND NOT EXISTS (SELECT 1 FROM inventory_documents d WHERE d.workspace_id=NEW.workspace_id AND d.id=NEW.inventory_document_id
      AND d.status='PROCESSED' AND d.reversed_at IS NULL AND d.document_type='SALES_ORDER' AND d.source_entity_type='ORDER' AND d.source_entity_id=NEW.order_id AND d.source_warehouse_id=NEW.warehouse_id)
  THEN RAISE EXCEPTION 'SHIPMENT_INVENTORY_POST_FAILED' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

