-- CreateTable
CREATE TABLE "commerce_stores" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "default_currency" CHAR(3) NOT NULL,
    "timezone" TEXT NOT NULL,
    "catalog_id" UUID NOT NULL,
    "price_type_id" UUID,
    "default_warehouse_id" UUID,
    "reservation_timing" TEXT NOT NULL DEFAULT 'ORDER_PLACED',
    "deal_creation_policy" TEXT NOT NULL DEFAULT 'ALWAYS',
    "abandoned_after_minutes" INTEGER NOT NULL DEFAULT 120,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "created_by_user_id" UUID NOT NULL,
    "version" BIGINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "commerce_stores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_storefronts" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "domain" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "configuration" JSONB NOT NULL DEFAULT '{}',
    "published_at" TIMESTAMPTZ(6),
    "version" BIGINT NOT NULL DEFAULT 1,

    CONSTRAINT "commerce_storefronts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_product_publications" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "variant_id" UUID,
    "inventory_key" UUID NOT NULL,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "available_from" TIMESTAMPTZ(6),
    "available_until" TIMESTAMPTZ(6),
    "seo_slug" TEXT NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "version" BIGINT NOT NULL DEFAULT 1,

    CONSTRAINT "commerce_product_publications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_category_publications" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "seo_slug" TEXT NOT NULL,
    "version" BIGINT NOT NULL DEFAULT 1,

    CONSTRAINT "commerce_category_publications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "commerce_stores_workspace_id_status_created_at_idx" ON "commerce_stores"("workspace_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_stores_workspace_id_id_key" ON "commerce_stores"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_stores_workspace_id_code_key" ON "commerce_stores"("workspace_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_storefronts_slug_key" ON "commerce_storefronts"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_storefronts_domain_key" ON "commerce_storefronts"("domain");

-- CreateIndex
CREATE INDEX "commerce_storefronts_workspace_id_store_id_status_idx" ON "commerce_storefronts"("workspace_id", "store_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_storefronts_workspace_id_id_key" ON "commerce_storefronts"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_storefronts_workspace_id_store_id_id_key" ON "commerce_storefronts"("workspace_id", "store_id", "id");

-- CreateIndex
CREATE INDEX "commerce_product_publications_workspace_id_store_id_publish_idx" ON "commerce_product_publications"("workspace_id", "store_id", "published");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_product_publications_workspace_id_id_key" ON "commerce_product_publications"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_product_publications_workspace_id_store_id_invento_key" ON "commerce_product_publications"("workspace_id", "store_id", "inventory_key");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_product_publications_store_id_seo_slug_key" ON "commerce_product_publications"("store_id", "seo_slug");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_category_publications_workspace_id_id_key" ON "commerce_category_publications"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_category_publications_workspace_id_store_id_catego_key" ON "commerce_category_publications"("workspace_id", "store_id", "category_id");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_category_publications_store_id_seo_slug_key" ON "commerce_category_publications"("store_id", "seo_slug");

CREATE UNIQUE INDEX IF NOT EXISTS commerce_catalog_tenant_identity ON catalogs(workspace_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS commerce_price_type_tenant_identity ON catalog_price_types(workspace_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS commerce_category_tenant_identity ON catalog_categories(workspace_id,id);
ALTER TABLE commerce_stores
  ADD CONSTRAINT commerce_store_workspace_fk FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
  ADD CONSTRAINT commerce_store_catalog_fk FOREIGN KEY (workspace_id,catalog_id) REFERENCES catalogs(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT commerce_store_price_type_fk FOREIGN KEY (workspace_id,price_type_id) REFERENCES catalog_price_types(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT commerce_store_warehouse_fk FOREIGN KEY (workspace_id,default_warehouse_id) REFERENCES inventory_warehouses(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT commerce_store_actor_fk FOREIGN KEY (workspace_id,created_by_user_id) REFERENCES workspace_memberships(workspace_id,user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT commerce_store_shape_ck CHECK (version>0 AND length(name) BETWEEN 1 AND 200 AND length(code) BETWEEN 1 AND 100
    AND status IN ('DRAFT','ACTIVE','SUSPENDED','ARCHIVED') AND default_currency ~ '^[A-Z]{3}$'
    AND reservation_timing IN ('CART','ORDER_PLACED','PAYMENT_AUTHORIZED','PAYMENT_PAID','MANUAL')
    AND deal_creation_policy IN ('NEVER','ALWAYS','ONLY_NEW_CUSTOMER','MANUAL_REVIEW') AND abandoned_after_minutes BETWEEN 5 AND 43200
    AND jsonb_typeof(settings)='object');
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['commerce_storefronts','commerce_product_publications','commerce_category_publications'] LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (workspace_id,store_id) REFERENCES commerce_stores(workspace_id,id) ON DELETE RESTRICT',t,t||'_store_fk');
  END LOOP;
END $$;
ALTER TABLE commerce_storefronts ADD CONSTRAINT commerce_storefront_shape_ck CHECK (version>0 AND type IN ('WEB','HEADLESS','MOBILE','SOCIAL','EMBEDDED')
  AND status IN ('DRAFT','PUBLISHED','SUSPENDED') AND slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug)<=160
  AND (status<>'PUBLISHED' OR (type IN ('WEB','HEADLESS') AND published_at IS NOT NULL)) AND jsonb_typeof(configuration)='object');
ALTER TABLE commerce_product_publications
  ADD CONSTRAINT commerce_publication_product_fk FOREIGN KEY (workspace_id,product_id) REFERENCES catalog_products(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT commerce_publication_variant_fk FOREIGN KEY (workspace_id,variant_id) REFERENCES catalog_products(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT commerce_publication_actor_fk FOREIGN KEY (workspace_id,created_by_user_id) REFERENCES workspace_memberships(workspace_id,user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT commerce_publication_shape_ck CHECK (version>0 AND inventory_key=COALESCE(variant_id,product_id) AND seo_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    AND length(seo_slug)<=160 AND (available_from IS NULL OR available_until IS NULL OR available_from<available_until));
ALTER TABLE commerce_category_publications
  ADD CONSTRAINT commerce_category_publication_fk FOREIGN KEY (workspace_id,category_id) REFERENCES catalog_categories(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT commerce_category_publication_shape_ck CHECK (version>0 AND seo_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(seo_slug)<=160);
CREATE FUNCTION commerce_publication_owner_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM commerce_stores s JOIN catalog_products p ON p.workspace_id=s.workspace_id AND p.catalog_id=s.catalog_id
    WHERE s.workspace_id=NEW.workspace_id AND s.id=NEW.store_id AND p.id=NEW.product_id
      AND ((NEW.variant_id IS NULL AND p.type IN ('SIMPLE_PRODUCT','SERVICE')) OR (p.type='PRODUCT_WITH_VARIANTS'
        AND EXISTS (SELECT 1 FROM catalog_products v WHERE v.workspace_id=p.workspace_id AND v.parent_id=p.id AND v.id=NEW.variant_id AND v.type='VARIANT'))))
    THEN RAISE EXCEPTION 'COMMERCE_ITEM_NOT_AVAILABLE' USING ERRCODE='23503'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commerce_publication_owner BEFORE INSERT OR UPDATE OF product_id,variant_id,inventory_key,store_id
  ON commerce_product_publications FOR EACH ROW EXECUTE FUNCTION commerce_publication_owner_guard();
CREATE FUNCTION commerce_category_publication_owner_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM commerce_stores s JOIN catalog_categories c ON c.workspace_id=s.workspace_id AND c.catalog_id=s.catalog_id
    WHERE s.workspace_id=NEW.workspace_id AND s.id=NEW.store_id AND c.id=NEW.category_id)
    THEN RAISE EXCEPTION 'COMMERCE_ITEM_NOT_AVAILABLE' USING ERRCODE='23503'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commerce_category_publication_owner BEFORE INSERT OR UPDATE OF category_id,store_id
  ON commerce_category_publications FOR EACH ROW EXECUTE FUNCTION commerce_category_publication_owner_guard();
