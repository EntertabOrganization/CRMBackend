CREATE TABLE commerce_returns (
  id UUID PRIMARY KEY,workspace_id UUID NOT NULL,store_id UUID NOT NULL,order_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'REQUESTED' CHECK(status IN ('REQUESTED','APPROVED','REJECTED','IN_TRANSIT','RECEIVED','INSPECTING','COMPLETED','CANCELLED')),
  reason TEXT NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),policy_snapshot JSONB NOT NULL,
  requested_by_user_id UUID NOT NULL REFERENCES users(id),approved_by_user_id UUID REFERENCES users(id),received_at TIMESTAMPTZ(6),
  version BIGINT NOT NULL DEFAULT 1 CHECK(version > 0),created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(workspace_id,id),UNIQUE(workspace_id,store_id,order_id,id),
  FOREIGN KEY(workspace_id,store_id,order_id) REFERENCES commerce_orders(workspace_id,store_id,id)
);
CREATE INDEX commerce_returns_workspace_id_store_id_status_created_at_idx ON commerce_returns(workspace_id,store_id,status,created_at);
CREATE TABLE commerce_return_lines (
  id UUID PRIMARY KEY,workspace_id UUID NOT NULL,store_id UUID NOT NULL,order_id UUID NOT NULL,return_id UUID NOT NULL,order_line_id UUID NOT NULL,
  quantity NUMERIC(18,6) NOT NULL CHECK(quantity>0),received_quantity NUMERIC(18,6) NOT NULL DEFAULT 0 CHECK(received_quantity>=0 AND received_quantity<=quantity),
  disposition TEXT CHECK(disposition IN ('SELLABLE','DAMAGED','REPAIR','REJECT')),inventory_document_line_id UUID UNIQUE,
  UNIQUE(workspace_id,return_id,order_line_id),
  FOREIGN KEY(workspace_id,store_id,order_id,return_id) REFERENCES commerce_returns(workspace_id,store_id,order_id,id),
  FOREIGN KEY(workspace_id,inventory_document_line_id) REFERENCES inventory_document_lines(workspace_id,id)
);
CREATE INDEX commerce_return_lines_workspace_id_order_id_order_line_id_idx ON commerce_return_lines(workspace_id,order_id,order_line_id);
CREATE TABLE commerce_return_events (
  id UUID PRIMARY KEY,workspace_id UUID NOT NULL,return_id UUID NOT NULL,actor_user_id UUID NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,details JSONB NOT NULL DEFAULT '{}',occurred_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(workspace_id,return_id) REFERENCES commerce_returns(workspace_id,id)
);
CREATE INDEX commerce_return_events_workspace_id_return_id_occurred_at_idx ON commerce_return_events(workspace_id,return_id,occurred_at);
CREATE TABLE commerce_return_commands (
  id UUID PRIMARY KEY,workspace_id UUID NOT NULL REFERENCES workspaces(id),actor_user_id UUID NOT NULL REFERENCES users(id),operation TEXT NOT NULL,key TEXT NOT NULL,
  request_hash TEXT NOT NULL,response JSONB NOT NULL,created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(workspace_id,actor_user_id,operation,key)
);
CREATE TRIGGER commerce_return_events_immutable BEFORE UPDATE OR DELETE ON commerce_return_events FOR EACH ROW EXECUTE FUNCTION commerce_checkout_evidence_immutable();
CREATE TRIGGER commerce_return_commands_immutable BEFORE UPDATE OR DELETE ON commerce_return_commands FOR EACH ROW EXECUTE FUNCTION commerce_checkout_evidence_immutable();
-- PostgreSQL also fences writes made outside the HTTP service, including races.
CREATE FUNCTION commerce_return_quantity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE delivered NUMERIC;claimed NUMERIC;
BEGIN
  PERFORM 1 FROM commerce_orders WHERE workspace_id=NEW.workspace_id AND id=NEW.order_id FOR UPDATE;
  IF NOT EXISTS(SELECT 1 FROM commerce_orders o CROSS JOIN LATERAL jsonb_array_elements(o.snapshot->'lines') l WHERE o.workspace_id=NEW.workspace_id AND o.id=NEW.order_id AND l->>'itemId'=NEW.order_line_id::text AND l->>'stockable'='true') THEN
    RAISE EXCEPTION 'RETURN_NOT_ELIGIBLE' USING ERRCODE='23514';
  END IF;
  SELECT COALESCE(sum(i.quantity),0) INTO delivered FROM commerce_shipment_items i JOIN commerce_shipments s ON s.workspace_id=i.workspace_id AND s.id=i.shipment_id WHERE i.workspace_id=NEW.workspace_id AND i.order_id=NEW.order_id AND i.order_line_id=NEW.order_line_id AND s.status='DELIVERED';
  SELECT COALESCE(sum(l.quantity),0) INTO claimed FROM commerce_return_lines l JOIN commerce_returns r ON r.workspace_id=l.workspace_id AND r.id=l.return_id WHERE l.workspace_id=NEW.workspace_id AND l.order_id=NEW.order_id AND l.order_line_id=NEW.order_line_id AND l.id<>NEW.id AND r.status NOT IN ('REJECTED','CANCELLED');
  IF claimed+NEW.quantity>delivered THEN RAISE EXCEPTION 'RETURN_QUANTITY_EXCEEDED' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' AND ROW(NEW.workspace_id,NEW.store_id,NEW.order_id,NEW.return_id,NEW.order_line_id,NEW.quantity) IS DISTINCT FROM ROW(OLD.workspace_id,OLD.store_id,OLD.order_id,OLD.return_id,OLD.order_line_id,OLD.quantity) THEN RAISE EXCEPTION 'RETURN_LINE_IMMUTABLE' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commerce_return_quantity BEFORE INSERT OR UPDATE ON commerce_return_lines FOR EACH ROW EXECUTE FUNCTION commerce_return_quantity_guard();
