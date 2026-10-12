-- CreateTable
CREATE TABLE "commerce_discount_rules" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" DECIMAL(24,6) NOT NULL,
    "applies_to" TEXT NOT NULL DEFAULT 'ORDER',
    "priority" INTEGER NOT NULL DEFAULT 100,
    "stack_group" TEXT NOT NULL DEFAULT 'DEFAULT',
    "combinable" BOOLEAN NOT NULL DEFAULT false,
    "eligibility" JSONB NOT NULL DEFAULT '{}',
    "usage_limit" INTEGER,
    "per_customer_limit" INTEGER,
    "starts_at" TIMESTAMPTZ(6),
    "ends_at" TIMESTAMPTZ(6),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" BIGINT NOT NULL DEFAULT 1,

    CONSTRAINT "commerce_discount_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_coupons" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "usage_limit" INTEGER,
    "per_customer_limit" INTEGER,
    "expires_at" TIMESTAMPTZ(6),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_coupons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_tax_rules" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "region" TEXT NOT NULL,
    "category_id" UUID,
    "rate" DECIMAL(10,6) NOT NULL,
    "price_basis" TEXT NOT NULL,
    "effective_from" TIMESTAMPTZ(6) NOT NULL,
    "effective_to" TIMESTAMPTZ(6),
    "version" BIGINT NOT NULL DEFAULT 1,

    CONSTRAINT "commerce_tax_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "commerce_discount_rules_workspace_id_store_id_active_priori_idx" ON "commerce_discount_rules"("workspace_id", "store_id", "active", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_discount_rules_workspace_id_id_key" ON "commerce_discount_rules"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_discount_rules_workspace_id_store_id_id_key" ON "commerce_discount_rules"("workspace_id", "store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_discount_rules_workspace_id_store_id_code_key" ON "commerce_discount_rules"("workspace_id", "store_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_coupons_workspace_id_id_key" ON "commerce_coupons"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_coupons_workspace_id_store_id_code_hash_key" ON "commerce_coupons"("workspace_id", "store_id", "code_hash");

-- CreateIndex
CREATE INDEX "commerce_tax_rules_workspace_id_store_id_region_effective_f_idx" ON "commerce_tax_rules"("workspace_id", "store_id", "region", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_tax_rules_workspace_id_id_key" ON "commerce_tax_rules"("workspace_id", "id");

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['commerce_discount_rules','commerce_coupons','commerce_tax_rules'] LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (workspace_id,store_id) REFERENCES commerce_stores(workspace_id,id) ON DELETE RESTRICT',t,t||'_store_fk');
  END LOOP;
END $$;
ALTER TABLE commerce_discount_rules ADD CONSTRAINT commerce_discount_shape_ck CHECK (version>0 AND kind IN ('PERCENT','FIXED','FREE_SHIPPING')
  AND value>=0 AND (kind<>'PERCENT' OR value<=100) AND (kind<>'FREE_SHIPPING' OR (value=0 AND applies_to='SHIPPING'))
  AND applies_to IN ('LINE','ORDER','SHIPPING') AND priority BETWEEN 0 AND 1000000 AND jsonb_typeof(eligibility)='object'
  AND (usage_limit IS NULL OR usage_limit>0) AND (per_customer_limit IS NULL OR per_customer_limit>0)
  AND (starts_at IS NULL OR ends_at IS NULL OR starts_at<ends_at));
ALTER TABLE commerce_coupons
  ADD CONSTRAINT commerce_coupon_rule_fk FOREIGN KEY (workspace_id,store_id,rule_id) REFERENCES commerce_discount_rules(workspace_id,store_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT commerce_coupon_shape_ck CHECK (length(code_hash)=64 AND (usage_limit IS NULL OR usage_limit>0) AND (per_customer_limit IS NULL OR per_customer_limit>0));
ALTER TABLE commerce_tax_rules
  ADD CONSTRAINT commerce_tax_category_fk FOREIGN KEY (workspace_id,category_id) REFERENCES catalog_categories(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT commerce_tax_shape_ck CHECK (version>0 AND rate BETWEEN 0 AND 100 AND price_basis IN ('INCLUSIVE','EXCLUSIVE')
    AND region ~ '^(\*|[A-Z]{2}(-[A-Z0-9]{1,10})?)$' AND (effective_to IS NULL OR effective_from<effective_to));
CREATE FUNCTION commerce_tax_rule_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.workspace_id::text||':'||NEW.store_id::text||':'||NEW.region||':'||COALESCE(NEW.category_id::text,''),1));
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(OLD)-ARRAY['effective_to','version']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['effective_to','version'])
      OR OLD.effective_to<=CURRENT_TIMESTAMP OR NEW.effective_to IS NULL OR NEW.effective_to<=CURRENT_TIMESTAMP
      THEN RAISE EXCEPTION 'COMMERCE_TAX_RULE_INVALID'; END IF;
  END IF;
  IF NEW.category_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM commerce_stores s JOIN catalog_categories c ON c.workspace_id=s.workspace_id AND c.catalog_id=s.catalog_id
    WHERE s.workspace_id=NEW.workspace_id AND s.id=NEW.store_id AND c.id=NEW.category_id) THEN RAISE EXCEPTION 'COMMERCE_TAX_RULE_INVALID' USING ERRCODE='23503'; END IF;
  IF EXISTS (SELECT 1 FROM commerce_tax_rules r WHERE r.workspace_id=NEW.workspace_id AND r.store_id=NEW.store_id AND r.id<>NEW.id AND r.region=NEW.region
    AND r.category_id IS NOT DISTINCT FROM NEW.category_id AND (NEW.effective_to IS NULL OR r.effective_from<NEW.effective_to)
    AND (r.effective_to IS NULL OR r.effective_to>NEW.effective_from)) THEN RAISE EXCEPTION 'COMMERCE_TAX_RULE_INVALID' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commerce_tax_rule_window BEFORE INSERT OR UPDATE ON commerce_tax_rules FOR EACH ROW EXECUTE FUNCTION commerce_tax_rule_guard();
