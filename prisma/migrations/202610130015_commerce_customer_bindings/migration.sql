CREATE TABLE commerce_customer_bindings (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  store_id UUID NOT NULL,
  customer_account_id UUID NOT NULL,
  entity_type TEXT NOT NULL CHECK(entity_type IN ('CONTACT','COMPANY')),
  contact_id UUID,
  company_id UUID,
  resolution_reason TEXT NOT NULL CHECK(length(btrim(resolution_reason)) BETWEEN 1 AND 2000),
  linked_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  version BIGINT NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(workspace_id,customer_account_id,entity_type),
  CHECK((entity_type='CONTACT' AND contact_id IS NOT NULL AND company_id IS NULL) OR (entity_type='COMPANY' AND company_id IS NOT NULL AND contact_id IS NULL)),
  FOREIGN KEY(workspace_id,store_id,customer_account_id) REFERENCES commerce_customer_accounts(workspace_id,store_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,contact_id) REFERENCES crm_contacts(workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,company_id) REFERENCES crm_companies(workspace_id,id) ON DELETE RESTRICT
);
CREATE INDEX commerce_customer_bindings_workspace_id_store_id_customer_account_id_idx ON commerce_customer_bindings(workspace_id,store_id,customer_account_id);
