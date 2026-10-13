CREATE TABLE commerce_order_line_reservations (
 id UUID PRIMARY KEY,workspace_id UUID NOT NULL,store_id UUID NOT NULL,order_id UUID NOT NULL,order_line_id UUID NOT NULL,
 reservation_id UUID NOT NULL,inventory_key UUID NOT NULL,quantity NUMERIC(24,6) NOT NULL CHECK(quantity>0),created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(workspace_id,reservation_id),
 FOREIGN KEY(workspace_id,store_id,order_id) REFERENCES commerce_orders(workspace_id,store_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id,reservation_id) REFERENCES inventory_reservations(workspace_id,id) ON DELETE RESTRICT
);
CREATE INDEX commerce_line_reservation_order_fk ON commerce_order_line_reservations(workspace_id,store_id,order_id);
CREATE INDEX commerce_line_reservation_line ON commerce_order_line_reservations(workspace_id,order_id,order_line_id);
CREATE FUNCTION commerce_order_line_reservation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source commerce_orders%ROWTYPE; reservation inventory_reservations%ROWTYPE; line JSONB; committed NUMERIC;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'COMMERCE_LINE_RESERVATION_IMMUTABLE' USING ERRCODE='23514'; END IF;
 SELECT * INTO source FROM commerce_orders WHERE workspace_id=NEW.workspace_id AND store_id=NEW.store_id AND id=NEW.order_id FOR UPDATE;
 SELECT * INTO reservation FROM inventory_reservations WHERE workspace_id=NEW.workspace_id AND id=NEW.reservation_id FOR KEY SHARE;
 SELECT value INTO line FROM jsonb_array_elements(COALESCE(source.snapshot->'lines','[]'::jsonb)) WHERE value->>'itemId'=NEW.order_line_id::text;
 IF line IS NULL OR line->>'stockable' IS DISTINCT FROM 'true' OR reservation.id IS NULL OR reservation.source_type<>'ORDER' OR reservation.source_id<>NEW.order_id
 OR reservation.status NOT IN ('ACTIVE','PARTIALLY_FULFILLED') OR reservation.expires_at<=CURRENT_TIMESTAMP
 OR reservation.inventory_key<>NEW.inventory_key OR line->>'inventoryKey' IS DISTINCT FROM NEW.inventory_key::text OR reservation.product_id::text IS DISTINCT FROM line->>'productId'
 OR reservation.variant_id::text IS DISTINCT FROM line->>'variantId' OR reservation.quantity<>NEW.quantity
 THEN RAISE EXCEPTION 'COMMERCE_LINE_RESERVATION_SOURCE_INVALID' USING ERRCODE='23503'; END IF;
 SELECT COALESCE(SUM(GREATEST(b.quantity-r.released_quantity,0)),0) INTO committed FROM commerce_order_line_reservations b JOIN inventory_reservations r ON r.workspace_id=b.workspace_id AND r.id=b.reservation_id
 WHERE b.workspace_id=NEW.workspace_id AND b.order_id=NEW.order_id AND b.order_line_id=NEW.order_line_id;
 IF committed+NEW.quantity>(line->>'quantity')::numeric THEN RAISE EXCEPTION 'COMMERCE_LINE_RESERVATION_QUANTITY_EXCEEDED' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER commerce_order_line_reservation_owner BEFORE INSERT OR UPDATE OR DELETE ON commerce_order_line_reservations FOR EACH ROW EXECUTE FUNCTION commerce_order_line_reservation_guard();
CREATE FUNCTION inventory_bound_order_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.workspace_id,NEW.source_type,NEW.source_id,NEW.inventory_key,NEW.product_id,NEW.variant_id,NEW.quantity) IS DISTINCT FROM ROW(OLD.workspace_id,OLD.source_type,OLD.source_id,OLD.inventory_key,OLD.product_id,OLD.variant_id,OLD.quantity)
 AND EXISTS(SELECT 1 FROM commerce_order_line_reservations WHERE workspace_id=OLD.workspace_id AND reservation_id=OLD.id)
 THEN RAISE EXCEPTION 'COMMERCE_LINE_RESERVATION_IMMUTABLE' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_bound_order_line_source BEFORE UPDATE ON inventory_reservations FOR EACH ROW EXECUTE FUNCTION inventory_bound_order_line_guard();
