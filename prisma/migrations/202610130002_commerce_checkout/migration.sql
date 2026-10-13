-- CreateTable
CREATE TABLE "commerce_checkout_sessions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "cart_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "customer_snapshot" JSONB NOT NULL,
    "address_snapshot" JSONB NOT NULL,
    "payer_type" TEXT NOT NULL,
    "quote_hash" TEXT,
    "quote" JSONB,
    "quote_input" JSONB,
    "quote_expires_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "order_id" UUID,
    "version" BIGINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_checkout_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_orders" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "cart_id" UUID NOT NULL,
    "checkout_session_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "currency" CHAR(3) NOT NULL,
    "total" DECIMAL(24,6) NOT NULL,
    "snapshot" JSONB NOT NULL,
    "consents" JSONB NOT NULL,
    "business_metadata" JSONB NOT NULL DEFAULT '{}',
    "archived_at" TIMESTAMPTZ(6),
    "version" BIGINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_order_history" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "actor_user_id" UUID,
    "details" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_order_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_checkout_commands" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_checkout_commands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_discount_redemptions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "coupon_id" UUID,
    "customer_key" TEXT NOT NULL,
    "amount" DECIMAL(24,6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_discount_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "commerce_checkout_sessions_token_hash_key" ON "commerce_checkout_sessions"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_checkout_sessions_order_id_key" ON "commerce_checkout_sessions"("order_id");

-- CreateIndex
CREATE INDEX "commerce_checkout_sessions_workspace_id_store_id_cart_id_idx" ON "commerce_checkout_sessions"("workspace_id", "store_id", "cart_id");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_checkout_sessions_workspace_id_store_id_id_key" ON "commerce_checkout_sessions"("workspace_id", "store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_orders_cart_id_key" ON "commerce_orders"("cart_id");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_orders_checkout_session_id_key" ON "commerce_orders"("checkout_session_id");

-- CreateIndex
CREATE INDEX "commerce_orders_workspace_id_store_id_status_created_at_idx" ON "commerce_orders"("workspace_id", "store_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_orders_workspace_id_store_id_id_key" ON "commerce_orders"("workspace_id", "store_id", "id");

-- CreateIndex
CREATE INDEX "commerce_order_history_workspace_id_order_id_occurred_at_idx" ON "commerce_order_history"("workspace_id", "order_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_checkout_commands_workspace_id_store_id_session_id_key" ON "commerce_checkout_commands"("workspace_id", "store_id", "session_id", "key");

-- CreateIndex
CREATE INDEX "commerce_discount_redemptions_workspace_id_store_id_rule_id_idx" ON "commerce_discount_redemptions"("workspace_id", "store_id", "rule_id", "customer_key");

-- CreateIndex
CREATE INDEX "commerce_discount_redemptions_workspace_id_store_id_coupon__idx" ON "commerce_discount_redemptions"("workspace_id", "store_id", "coupon_id", "customer_key");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_discount_redemptions_order_id_rule_id_key" ON "commerce_discount_redemptions"("order_id", "rule_id");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_discount_redemptions_order_id_coupon_id_key" ON "commerce_discount_redemptions"("order_id", "coupon_id");

ALTER TABLE commerce_checkout_sessions ADD CONSTRAINT checkout_cart_fk FOREIGN KEY(workspace_id,store_id,cart_id)
  REFERENCES commerce_carts(workspace_id,store_id,id) ON DELETE RESTRICT;
ALTER TABLE commerce_checkout_sessions ADD CONSTRAINT checkout_state_check CHECK
  (status IN ('DRAFT','QUOTED','ORDERED','EXPIRED') AND version>0 AND token_hash ~ '^[a-f0-9]{64}$'
   AND (status!='ORDERED' OR order_id IS NOT NULL));
ALTER TABLE commerce_orders ADD CONSTRAINT order_cart_fk FOREIGN KEY(workspace_id,store_id,cart_id)
  REFERENCES commerce_carts(workspace_id,store_id,id) ON DELETE RESTRICT;
ALTER TABLE commerce_orders ADD CONSTRAINT order_checkout_fk FOREIGN KEY(workspace_id,store_id,checkout_session_id)
  REFERENCES commerce_checkout_sessions(workspace_id,store_id,id) ON DELETE RESTRICT;
ALTER TABLE commerce_checkout_sessions ADD CONSTRAINT checkout_order_fk FOREIGN KEY(workspace_id,store_id,order_id)
  REFERENCES commerce_orders(workspace_id,store_id,id) ON DELETE RESTRICT;
ALTER TABLE commerce_orders ADD CONSTRAINT order_totals_check CHECK(total>=0 AND version>0);
CREATE FUNCTION commerce_order_checkout_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM commerce_checkout_sessions s WHERE s.workspace_id=NEW.workspace_id
    AND s.store_id=NEW.store_id AND s.id=NEW.checkout_session_id AND s.cart_id=NEW.cart_id)
  THEN RAISE EXCEPTION 'COMMERCE_CHECKOUT_INVALID' USING ERRCODE='23503'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commerce_order_checkout BEFORE INSERT ON commerce_orders FOR EACH ROW EXECUTE FUNCTION commerce_order_checkout_guard();
ALTER TABLE commerce_order_history ADD CONSTRAINT order_history_fk FOREIGN KEY(workspace_id,store_id,order_id)
  REFERENCES commerce_orders(workspace_id,store_id,id) ON DELETE RESTRICT;
ALTER TABLE commerce_order_history ADD CONSTRAINT order_history_actor_fk FOREIGN KEY(workspace_id,actor_user_id)
  REFERENCES workspace_memberships(workspace_id,user_id) ON DELETE RESTRICT;
ALTER TABLE commerce_checkout_commands ADD CONSTRAINT checkout_command_fk FOREIGN KEY(workspace_id,store_id,session_id)
  REFERENCES commerce_checkout_sessions(workspace_id,store_id,id) ON DELETE RESTRICT;
ALTER TABLE commerce_checkout_commands ADD CONSTRAINT checkout_command_shape_check CHECK(length(key) BETWEEN 8 AND 128 AND request_hash ~ '^[a-f0-9]{64}$');
ALTER TABLE commerce_discount_redemptions ADD CONSTRAINT redemption_amount_check CHECK(amount>=0);
ALTER TABLE commerce_discount_redemptions ADD CONSTRAINT redemption_order_fk FOREIGN KEY(workspace_id,store_id,order_id)
  REFERENCES commerce_orders(workspace_id,store_id,id) ON DELETE RESTRICT;
ALTER TABLE commerce_discount_redemptions ADD CONSTRAINT redemption_rule_fk FOREIGN KEY(workspace_id,store_id,rule_id)
  REFERENCES commerce_discount_rules(workspace_id,store_id,id) ON DELETE RESTRICT;
CREATE FUNCTION commerce_redemption_coupon_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.coupon_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM commerce_coupons c WHERE c.workspace_id=NEW.workspace_id
    AND c.store_id=NEW.store_id AND c.id=NEW.coupon_id AND c.rule_id=NEW.rule_id)
  THEN RAISE EXCEPTION 'COMMERCE_COUPON_INVALID' USING ERRCODE='23503'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commerce_redemption_coupon BEFORE INSERT ON commerce_discount_redemptions
  FOR EACH ROW EXECUTE FUNCTION commerce_redemption_coupon_guard();
CREATE FUNCTION commerce_order_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'COMMERCE_ORDER_IMMUTABLE' USING ERRCODE='23514'; END IF;
  IF ROW(NEW.workspace_id,NEW.store_id,NEW.cart_id,NEW.checkout_session_id,NEW.currency,NEW.total,NEW.snapshot,NEW.consents,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.workspace_id,OLD.store_id,OLD.cart_id,OLD.checkout_session_id,OLD.currency,OLD.total,OLD.snapshot,OLD.consents,OLD.created_at)
  THEN RAISE EXCEPTION 'COMMERCE_ORDER_IMMUTABLE' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commerce_order_immutable BEFORE UPDATE OR DELETE ON commerce_orders FOR EACH ROW EXECUTE FUNCTION commerce_order_immutable_guard();
CREATE FUNCTION commerce_checkout_evidence_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'COMMERCE_EVIDENCE_IMMUTABLE' USING ERRCODE='23514'; END $$;
CREATE TRIGGER commerce_order_history_immutable BEFORE UPDATE OR DELETE ON commerce_order_history FOR EACH ROW EXECUTE FUNCTION commerce_checkout_evidence_immutable();
CREATE TRIGGER commerce_redemption_immutable BEFORE UPDATE OR DELETE ON commerce_discount_redemptions FOR EACH ROW EXECUTE FUNCTION commerce_checkout_evidence_immutable();
CREATE TRIGGER commerce_checkout_command_immutable BEFORE UPDATE OR DELETE ON commerce_checkout_commands FOR EACH ROW EXECUTE FUNCTION commerce_checkout_evidence_immutable();

