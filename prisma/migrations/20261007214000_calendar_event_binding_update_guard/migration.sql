-- Re-check changed polymorphic targets while leaving historical references untouched on ordinary upserts.
CREATE TRIGGER "calendar_event_binding_update_tenant_guard"
  BEFORE UPDATE ON "calendar_event_bindings"
  FOR EACH ROW
  WHEN (OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
    OR OLD.entity_type IS DISTINCT FROM NEW.entity_type
    OR OLD.entity_id IS DISTINCT FROM NEW.entity_id)
  EXECUTE FUNCTION calendar_event_binding_tenant_guard();
