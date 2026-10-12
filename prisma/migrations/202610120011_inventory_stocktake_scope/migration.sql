-- Preserve the selected counting scope when refreshing the baseline at session start.
ALTER TABLE stocktake_sessions ADD COLUMN scope JSONB NOT NULL DEFAULT '{"mode":"ALL"}'::jsonb;
ALTER TABLE inventory_movements ADD COLUMN ledger_sequence BIGSERIAL NOT NULL;
CREATE UNIQUE INDEX inventory_movements_ledger_sequence_key ON inventory_movements(ledger_sequence);
ALTER TABLE stocktake_sessions ADD COLUMN baseline_ledger_sequence BIGINT NOT NULL DEFAULT 0;
ALTER TABLE stocktake_lines ADD COLUMN counted_ledger_sequence BIGINT;
ALTER TABLE stocktake_lines ADD CONSTRAINT stocktake_count_watermark_shape CHECK (
  (counted_qty IS NULL)=(counted_ledger_sequence IS NULL) AND (counted_ledger_sequence IS NULL OR counted_ledger_sequence>=0));
CREATE FUNCTION inventory_posted_stocktake_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ws uuid; sid uuid; BEGIN
  IF TG_OP='DELETE' THEN ws:=OLD.workspace_id; sid:=OLD.session_id; ELSE ws:=NEW.workspace_id; sid:=NEW.session_id; END IF;
  IF EXISTS (SELECT 1 FROM stocktake_sessions WHERE workspace_id=ws AND id=sid AND status IN ('POSTED','CANCELLED'))
    THEN RAISE EXCEPTION 'STOCKTAKE_INVALID_STATUS'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stocktake_closed_line BEFORE INSERT OR UPDATE OR DELETE ON stocktake_lines FOR EACH ROW EXECUTE FUNCTION inventory_posted_stocktake_line_guard();
ALTER TABLE stocktake_sessions ADD CONSTRAINT stocktake_scope_shape CHECK (
  jsonb_typeof(scope)='object' AND scope->>'mode' IN ('ALL','SELECTED_SKUS')
  AND (scope->>'mode'<>'SELECTED_SKUS' OR jsonb_typeof(scope->'inventoryKeys')='array'));
