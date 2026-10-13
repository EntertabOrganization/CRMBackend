-- CreateTable
CREATE TABLE "commerce_carts" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "currency" CHAR(3) NOT NULL,
    "version" BIGINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_activity_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "commerce_carts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_cart_items" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "cart_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "variant_id" UUID,
    "inventory_key" UUID NOT NULL,
    "quantity" DECIMAL(18,6) NOT NULL,
    "options" JSONB NOT NULL DEFAULT '{}',
    "options_hash" TEXT NOT NULL,
    "version" BIGINT NOT NULL DEFAULT 1,

    CONSTRAINT "commerce_cart_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "commerce_carts_token_hash_key" ON "commerce_carts"("token_hash");

-- CreateIndex
CREATE INDEX "commerce_carts_workspace_id_store_id_status_expires_at_idx" ON "commerce_carts"("workspace_id", "store_id", "status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_carts_workspace_id_store_id_id_key" ON "commerce_carts"("workspace_id", "store_id", "id");

-- CreateIndex
CREATE INDEX "commerce_cart_items_workspace_id_store_id_cart_id_idx" ON "commerce_cart_items"("workspace_id", "store_id", "cart_id");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_cart_items_cart_id_inventory_key_options_hash_key" ON "commerce_cart_items"("cart_id", "inventory_key", "options_hash");

ALTER TABLE commerce_carts ADD CONSTRAINT commerce_cart_store_fk
  FOREIGN KEY (workspace_id,store_id) REFERENCES commerce_stores(workspace_id,id) ON DELETE RESTRICT;
ALTER TABLE commerce_carts ADD CONSTRAINT commerce_cart_state_check CHECK
  (status IN ('ACTIVE','CHECKOUT','CONVERTED','ABANDONED','EXPIRED') AND version>0 AND expires_at>created_at AND token_hash ~ '^[a-f0-9]{64}$');
ALTER TABLE commerce_cart_items ADD CONSTRAINT commerce_cart_item_cart_fk
  FOREIGN KEY (workspace_id,store_id,cart_id) REFERENCES commerce_carts(workspace_id,store_id,id) ON DELETE RESTRICT;
ALTER TABLE commerce_cart_items ADD CONSTRAINT commerce_cart_item_sku_fk
  FOREIGN KEY (workspace_id,store_id,inventory_key) REFERENCES commerce_product_publications(workspace_id,store_id,inventory_key) ON DELETE RESTRICT;
ALTER TABLE commerce_cart_items ADD CONSTRAINT commerce_cart_item_quantity_check CHECK
  (quantity>0 AND version>0 AND inventory_key=COALESCE(variant_id,product_id) AND jsonb_typeof(options)='object');
CREATE FUNCTION commerce_cart_item_owner_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM commerce_product_publications p WHERE p.workspace_id=NEW.workspace_id
    AND p.store_id=NEW.store_id AND p.inventory_key=NEW.inventory_key AND p.product_id=NEW.product_id
    AND p.variant_id IS NOT DISTINCT FROM NEW.variant_id)
  THEN RAISE EXCEPTION 'COMMERCE_ITEM_NOT_AVAILABLE' USING ERRCODE='23503'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commerce_cart_item_owner BEFORE INSERT OR UPDATE OF workspace_id,store_id,product_id,variant_id,inventory_key
  ON commerce_cart_items FOR EACH ROW EXECUTE FUNCTION commerce_cart_item_owner_guard();

