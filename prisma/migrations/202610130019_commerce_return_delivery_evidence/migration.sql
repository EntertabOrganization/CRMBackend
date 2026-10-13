-- A later logistics RETURNED/FAILED status does not erase historical delivery.
CREATE OR REPLACE FUNCTION commerce_return_quantity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE delivered NUMERIC;claimed NUMERIC;
BEGIN
  PERFORM 1 FROM commerce_orders WHERE workspace_id=NEW.workspace_id AND id=NEW.order_id FOR UPDATE;
  IF NOT EXISTS(SELECT 1 FROM commerce_orders o CROSS JOIN LATERAL jsonb_array_elements(o.snapshot->'lines') l WHERE o.workspace_id=NEW.workspace_id AND o.id=NEW.order_id AND l->>'itemId'=NEW.order_line_id::text AND l->>'stockable'='true') THEN
    RAISE EXCEPTION 'RETURN_NOT_ELIGIBLE' USING ERRCODE='23514';
  END IF;
  SELECT COALESCE(sum(i.quantity),0) INTO delivered FROM commerce_shipment_items i JOIN commerce_shipments s ON s.workspace_id=i.workspace_id AND s.id=i.shipment_id WHERE i.workspace_id=NEW.workspace_id AND i.order_id=NEW.order_id AND i.order_line_id=NEW.order_line_id AND s.delivered_at IS NOT NULL;
  SELECT COALESCE(sum(l.quantity),0) INTO claimed FROM commerce_return_lines l JOIN commerce_returns r ON r.workspace_id=l.workspace_id AND r.id=l.return_id WHERE l.workspace_id=NEW.workspace_id AND l.order_id=NEW.order_id AND l.order_line_id=NEW.order_line_id AND l.id<>NEW.id AND r.status NOT IN ('REJECTED','CANCELLED');
  IF claimed+NEW.quantity>delivered THEN RAISE EXCEPTION 'RETURN_QUANTITY_EXCEEDED' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' AND ROW(NEW.workspace_id,NEW.store_id,NEW.order_id,NEW.return_id,NEW.order_line_id,NEW.quantity) IS DISTINCT FROM ROW(OLD.workspace_id,OLD.store_id,OLD.order_id,OLD.return_id,OLD.order_line_id,OLD.quantity) THEN RAISE EXCEPTION 'RETURN_LINE_IMMUTABLE' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
