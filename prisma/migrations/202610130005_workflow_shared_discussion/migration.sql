-- Discussion references derive from the owning Execution ID; comments stay in shared Timeline.
CREATE FUNCTION workflow_shared_timeline_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.entity_type='WORKFLOW_EXECUTION' THEN
    IF NOT EXISTS (SELECT 1 FROM workflow_executions e WHERE e.workspace_id=NEW.workspace_id AND e.id=NEW.entity_id)
      OR NOT EXISTS (SELECT 1 FROM workspace_memberships m WHERE m.workspace_id=NEW.workspace_id AND m.user_id=NEW.author_user_id)
    THEN RAISE EXCEPTION 'WORKFLOW_EXECUTION_NOT_FOUND' USING ERRCODE='23503'; END IF;
    IF TG_OP='UPDATE' AND NEW.is_deleted AND NOT OLD.is_deleted AND EXISTS
      (SELECT 1 FROM workflow_executions e WHERE e.workspace_id=NEW.workspace_id AND e.id=NEW.entity_id AND e.legal_hold)
    THEN RAISE EXCEPTION 'WORKFLOW_RETENTION_HOLD' USING ERRCODE='23514'; END IF;
  END IF;
  IF TG_OP='UPDATE' AND OLD.entity_type='WORKFLOW_EXECUTION' AND ROW(NEW.workspace_id,NEW.entity_type,NEW.entity_id,NEW.author_user_id)
    IS DISTINCT FROM ROW(OLD.workspace_id,OLD.entity_type,OLD.entity_id,OLD.author_user_id)
  THEN RAISE EXCEPTION 'WORKFLOW_DISCUSSION_IMMUTABLE' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workflow_shared_timeline BEFORE INSERT OR UPDATE ON crm_timeline_comments FOR EACH ROW EXECUTE FUNCTION workflow_shared_timeline_guard();
