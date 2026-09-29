-- TrueCRM Commercial, Capture & Contact Center durable aggregate store.
-- Existing migrations are intentionally untouched. Domain services enforce typed invariants and all rows carry a
-- server-resolved Workspace. PostgreSQL checks prevent malformed aggregate envelopes from entering the store.
CREATE TABLE "commercial_pack_records" (
  "id" UUID NOT NULL,
  "workspace_id" UUID,
  "collection" TEXT NOT NULL,
  "data" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "commercial_pack_records_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "commercial_pack_records_data_object" CHECK (jsonb_typeof("data") = 'object'),
  CONSTRAINT "commercial_pack_records_workspace_match" CHECK (
    "workspace_id" IS NULL OR NOT ("data" ? 'workspaceId') OR ("data"->>'workspaceId')::uuid = "workspace_id"
  )
);
CREATE INDEX "commercial_pack_records_workspace_id_collection_idx" ON "commercial_pack_records"("workspace_id", "collection");
CREATE INDEX "commercial_pack_records_collection_idx" ON "commercial_pack_records"("collection");
CREATE UNIQUE INDEX "commercial_pack_records_public_form_key_uq"
  ON "commercial_pack_records" (("data"->>'publicKey')) WHERE "collection" = 'crmForms';
CREATE UNIQUE INDEX "commercial_pack_records_provider_event_uq"
  ON "commercial_pack_records" (("data"->>'providerKey'), ("data"->>'connectionKey'), ("data"->>'externalEventId'))
  WHERE "collection" = 'paymentProviderEvents';
CREATE UNIQUE INDEX "commercial_pack_records_channel_event_uq"
  ON "commercial_pack_records" (("data"->>'connectionId'), ("data"->>'externalEventId'))
  WHERE "collection" = 'channelProviderEvents';
CREATE UNIQUE INDEX "commercial_pack_records_recurring_occurrence_uq"
  ON "commercial_pack_records" (("data"->>'ruleId'), ("data"->>'occurrenceKey'))
  WHERE "collection" = 'recurringOccurrences';
CREATE UNIQUE INDEX "commercial_pack_records_invoice_number_uq"
  ON "commercial_pack_records" ("workspace_id", ("data"->>'invoiceNumber'))
  WHERE "collection" = 'invoices' AND "data"->>'invoiceNumber' IS NOT NULL;
