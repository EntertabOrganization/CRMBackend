-- A user-visible tombstone must preserve the last content revision under Legal Hold.
CREATE FUNCTION chat_message_hold_proof() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE chat collaboration_chats%ROWTYPE;
BEGIN
 IF OLD.status = 'ACTIVE' AND NEW.status = 'DELETED' THEN
  SELECT * INTO chat FROM collaboration_chats WHERE id = NEW.chat_id AND workspace_id = NEW.workspace_id;
  IF EXISTS (SELECT 1 FROM commercial_pack_records h WHERE h.workspace_id = NEW.workspace_id AND h.collection = 'retentionRecords'
    AND h.data->>'legalHold' = 'true' AND (h.data->>'purgedAt') IS NULL
    AND h.data->>'resourceId' IN (NEW.id::text, NEW.chat_id::text, NEW.workspace_id::text, chat.linked_collab_id::text, chat.linked_department_id::text, chat.linked_project_id::text))
   AND NOT EXISTS (SELECT 1 FROM chat_message_versions v WHERE v.workspace_id = OLD.workspace_id AND v.message_id = OLD.id
     AND v.version_number = OLD.version AND v.body IS NOT DISTINCT FROM OLD.body) THEN
   RAISE EXCEPTION 'MESSAGE_LEGAL_HOLD' USING ERRCODE = '23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER chat_message_hold_proof AFTER UPDATE ON chat_messages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION chat_message_hold_proof();
CREATE TRIGGER chat_message_hold_revision BEFORE INSERT OR UPDATE OR DELETE ON chat_messages FOR EACH ROW EXECUTE FUNCTION calendar_booking_source_epoch();
CREATE TRIGGER chat_message_version_hold_revision BEFORE INSERT OR UPDATE OR DELETE ON chat_message_versions FOR EACH ROW EXECUTE FUNCTION calendar_booking_source_epoch();
