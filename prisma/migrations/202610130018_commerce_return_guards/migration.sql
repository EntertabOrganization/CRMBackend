ALTER TABLE commerce_returns ADD CONSTRAINT commerce_return_requester_scope_fk FOREIGN KEY(workspace_id,requested_by_user_id) REFERENCES workspace_memberships(workspace_id,user_id);
ALTER TABLE commerce_returns ADD CONSTRAINT commerce_return_approver_scope_fk FOREIGN KEY(workspace_id,approved_by_user_id) REFERENCES workspace_memberships(workspace_id,user_id);
ALTER TABLE commerce_return_events ADD CONSTRAINT commerce_return_event_actor_scope_fk FOREIGN KEY(workspace_id,actor_user_id) REFERENCES workspace_memberships(workspace_id,user_id);
CREATE FUNCTION commerce_return_line_lifecycle_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_status TEXT;
BEGIN
  SELECT status INTO parent_status FROM commerce_returns WHERE workspace_id=NEW.workspace_id AND id=NEW.return_id;
  IF TG_OP='INSERT' AND parent_status<>'REQUESTED' THEN RAISE EXCEPTION 'RETURN_INVALID_TRANSITION' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.received_quantity<>OLD.received_quantity AND (parent_status NOT IN ('APPROVED','IN_TRANSIT','RECEIVED') OR NEW.received_quantity<OLD.received_quantity) THEN RAISE EXCEPTION 'RETURN_INVALID_TRANSITION' USING ERRCODE='23514'; END IF;
    IF ROW(NEW.disposition,NEW.inventory_document_line_id) IS DISTINCT FROM ROW(OLD.disposition,OLD.inventory_document_line_id) AND (parent_status<>'RECEIVED' OR OLD.disposition IS NOT NULL OR NEW.received_quantity<>NEW.quantity) THEN RAISE EXCEPTION 'RETURN_INSPECTION_IMMUTABLE' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commerce_return_line_lifecycle BEFORE INSERT OR UPDATE ON commerce_return_lines FOR EACH ROW EXECUTE FUNCTION commerce_return_line_lifecycle_guard();
CREATE TRIGGER commerce_return_lines_preserved BEFORE DELETE ON commerce_return_lines FOR EACH ROW EXECUTE FUNCTION commerce_checkout_evidence_immutable();
