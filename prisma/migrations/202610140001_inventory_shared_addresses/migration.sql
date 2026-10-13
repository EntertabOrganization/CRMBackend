-- Shared Address bindings retain the owning module's identity and Workspace chain.
CREATE OR REPLACE FUNCTION inventory_shared_address_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  address_data jsonb;
  requisite_data jsonb;
BEGIN
  IF NEW.address_id IS NULL THEN RETURN NEW; END IF;
  -- An archived owning record may remain part of a historical binding.
  IF TG_OP = 'UPDATE' AND NEW.address_id IS NOT DISTINCT FROM OLD.address_id
      AND NEW.workspace_id = OLD.workspace_id THEN RETURN NEW; END IF;
  SELECT data INTO address_data FROM commercial_pack_records
    WHERE id = NEW.address_id AND workspace_id = NEW.workspace_id AND collection = 'requisiteAddresses';
  IF address_data IS NULL OR address_data->>'active' IS DISTINCT FROM 'true'
      OR address_data->>'workspaceId' IS DISTINCT FROM NEW.workspace_id::text THEN
    RAISE EXCEPTION 'Warehouse Address ownership chain is unavailable' USING ERRCODE = '23503';
  END IF;
  SELECT data INTO requisite_data FROM commercial_pack_records
    WHERE id::text = address_data->>'requisiteId' AND workspace_id = NEW.workspace_id AND collection = 'requisites';
  IF requisite_data IS NULL OR requisite_data->>'active' IS DISTINCT FROM 'true'
      OR requisite_data->>'workspaceId' IS DISTINCT FROM NEW.workspace_id::text THEN
    RAISE EXCEPTION 'Warehouse Address ownership chain is unavailable' USING ERRCODE = '23503';
  END IF;
  IF NOT COALESCE((requisite_data->>'ownerType' = 'COMPANY' AND EXISTS (
      SELECT 1 FROM crm_companies WHERE id::text = requisite_data->>'ownerId' AND workspace_id = NEW.workspace_id AND NOT is_deleted))
    OR (requisite_data->>'ownerType' = 'CONTACT' AND EXISTS (
      SELECT 1 FROM crm_contacts WHERE id::text = requisite_data->>'ownerId' AND workspace_id = NEW.workspace_id AND NOT is_deleted)), false) THEN
    RAISE EXCEPTION 'Warehouse Address ownership chain is unavailable' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER inventory_warehouse_shared_address_guard
  BEFORE INSERT OR UPDATE OF address_id, workspace_id ON inventory_warehouses
  FOR EACH ROW EXECUTE FUNCTION inventory_shared_address_guard();
