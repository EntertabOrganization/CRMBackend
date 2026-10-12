-- CreateTable
CREATE TABLE "spa_item_contacts" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,

    CONSTRAINT "spa_item_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "spa_item_contacts_workspace_id_item_id_contact_id_key" ON "spa_item_contacts"("workspace_id", "item_id", "contact_id");

CREATE UNIQUE INDEX IF NOT EXISTS "crm_contacts_workspace_id_id_spa_fk" ON "crm_contacts"("workspace_id", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "crm_companies_workspace_id_id_spa_fk" ON "crm_companies"("workspace_id", "id");
ALTER TABLE "spa_item_contacts"
  ADD CONSTRAINT "spa_contact_item_fk" FOREIGN KEY ("workspace_id", "item_id") REFERENCES "spa_items"("workspace_id", "id") ON DELETE CASCADE,
  ADD CONSTRAINT "spa_contact_crm_fk" FOREIGN KEY ("workspace_id", "contact_id") REFERENCES "crm_contacts"("workspace_id", "id") ON DELETE RESTRICT;
ALTER TABLE "spa_items" ADD CONSTRAINT "spa_item_company_fk" FOREIGN KEY ("workspace_id", "company_id") REFERENCES "crm_companies"("workspace_id", "id") ON DELETE RESTRICT;

-- A tenant-correct field cannot be attached to an Item of another SPA Type.
CREATE FUNCTION spa_validate_value_type() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM spa_items i JOIN spa_field_definitions f
    ON f.workspace_id=i.workspace_id AND f.type_id=i.type_id
    WHERE i.workspace_id=NEW.workspace_id AND i.id=NEW.item_id AND f.id=NEW.field_id) THEN
    RAISE EXCEPTION 'SPA_FIELD_TYPE_INVALID' USING ERRCODE='23503';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER spa_value_type_tenant BEFORE INSERT OR UPDATE ON spa_item_field_values FOR EACH ROW EXECUTE FUNCTION spa_validate_value_type();
