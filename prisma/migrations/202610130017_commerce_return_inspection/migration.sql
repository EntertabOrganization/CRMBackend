ALTER TABLE commerce_returns ADD COLUMN inspection_plan JSONB;
CREATE FUNCTION commerce_return_lifecycle_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'RETURN_HISTORY_PRESERVED' USING ERRCODE='23514'; END IF;
  IF ROW(NEW.workspace_id,NEW.store_id,NEW.order_id,NEW.reason,NEW.policy_snapshot,NEW.requested_by_user_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.workspace_id,OLD.store_id,OLD.order_id,OLD.reason,OLD.policy_snapshot,OLD.requested_by_user_id,OLD.created_at) THEN RAISE EXCEPTION 'RETURN_IDENTITY_IMMUTABLE' USING ERRCODE='23514'; END IF;
  IF OLD.inspection_plan IS NOT NULL AND NEW.inspection_plan IS DISTINCT FROM OLD.inspection_plan THEN RAISE EXCEPTION 'RETURN_INSPECTION_IMMUTABLE' USING ERRCODE='23514'; END IF;
  IF NEW.status<>OLD.status AND NOT ((OLD.status='REQUESTED' AND NEW.status IN ('APPROVED','REJECTED','CANCELLED')) OR (OLD.status='APPROVED' AND NEW.status IN ('IN_TRANSIT','RECEIVED','CANCELLED')) OR (OLD.status='IN_TRANSIT' AND NEW.status='RECEIVED') OR (OLD.status='RECEIVED' AND NEW.status IN ('INSPECTING','COMPLETED')) OR (OLD.status='INSPECTING' AND NEW.status='COMPLETED')) THEN RAISE EXCEPTION 'RETURN_INVALID_TRANSITION' USING ERRCODE='23514'; END IF;
  IF NEW.status='COMPLETED' AND EXISTS(SELECT 1 FROM commerce_return_lines l WHERE l.workspace_id=NEW.workspace_id AND l.return_id=NEW.id AND (l.received_quantity<>l.quantity OR l.disposition IS NULL OR (l.disposition<>'REJECT' AND NOT EXISTS(SELECT 1 FROM inventory_document_lines dl JOIN inventory_documents d ON d.workspace_id=dl.workspace_id AND d.id=dl.document_id WHERE dl.workspace_id=l.workspace_id AND dl.id=l.inventory_document_line_id AND d.status='PROCESSED' AND d.reversed_at IS NULL)))) THEN RAISE EXCEPTION 'RETURN_INSPECTION_INCOMPLETE' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commerce_return_lifecycle BEFORE UPDATE OR DELETE ON commerce_returns FOR EACH ROW EXECUTE FUNCTION commerce_return_lifecycle_guard();
