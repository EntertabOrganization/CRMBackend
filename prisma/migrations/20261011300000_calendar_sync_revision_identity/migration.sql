-- Preserve the foundation's immutable creation timestamp and forward-only revision invariants.
CREATE FUNCTION calendar_sync_revision_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.created_at IS DISTINCT FROM OLD.created_at OR
   (to_jsonb(NEW)->>'version')::int < (to_jsonb(OLD)->>'version')::int THEN
  RAISE EXCEPTION 'CALENDAR_SYNC_MAPPING_INVALID' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE tab TEXT; BEGIN
 FOREACH tab IN ARRAY ARRAY['calendar_sync_connections','integration_calendar_credentials','calendar_sync_mappings','calendar_sync_conflicts'] LOOP
  EXECUTE format('CREATE TRIGGER calendar_sync_revision_identity BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION calendar_sync_revision_identity()',tab);
 END LOOP;
END $$;
