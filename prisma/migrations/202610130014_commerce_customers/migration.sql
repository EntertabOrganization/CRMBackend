-- Customer identity is separate from Workspace employee membership. Historical
-- guest Orders are deliberately not backfilled by matching an unverified email.
CREATE TABLE commerce_customer_accounts (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  store_id UUID NOT NULL,
  identity_auth_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  email_normalized TEXT NOT NULL CHECK (email_normalized = lower(btrim(email_normalized))),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (workspace_id,store_id,id),
  UNIQUE (workspace_id,store_id,identity_auth_id),
  FOREIGN KEY (workspace_id,store_id) REFERENCES commerce_stores(workspace_id,id) ON DELETE RESTRICT
);
CREATE INDEX commerce_customer_accounts_workspace_id_store_id_created_at_idx ON commerce_customer_accounts(workspace_id,store_id,created_at);
ALTER TABLE commerce_checkout_sessions ADD COLUMN customer_account_id UUID;
ALTER TABLE commerce_orders ADD COLUMN customer_account_id UUID;
ALTER TABLE commerce_checkout_sessions ADD CONSTRAINT commerce_checkout_customer_fk FOREIGN KEY(workspace_id,store_id,customer_account_id) REFERENCES commerce_customer_accounts(workspace_id,store_id,id) ON DELETE RESTRICT;
ALTER TABLE commerce_orders ADD CONSTRAINT commerce_order_customer_fk FOREIGN KEY(workspace_id,store_id,customer_account_id) REFERENCES commerce_customer_accounts(workspace_id,store_id,id) ON DELETE RESTRICT;
CREATE INDEX commerce_orders_workspace_id_store_id_customer_account_id_created_at_idx ON commerce_orders(workspace_id,store_id,customer_account_id,created_at);
CREATE FUNCTION commerce_customer_order_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.customer_account_id IS DISTINCT FROM OLD.customer_account_id THEN
    RAISE EXCEPTION 'Order customer identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commerce_order_customer_identity BEFORE UPDATE ON commerce_orders FOR EACH ROW EXECUTE FUNCTION commerce_customer_order_identity_guard();
