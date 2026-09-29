-- Additional database backstops discovered during the Commercial/Capture/Contact-Center acceptance review.
CREATE UNIQUE INDEX "commercial_pack_invoice_sequence_scope_uq"
  ON "commercial_pack_records" ("workspace_id", COALESCE("data"->>'sellerCompanyId', ''))
  WHERE "collection" = 'invoiceSequences';

CREATE UNIQUE INDEX "commercial_pack_payment_attempt_idempotency_uq"
  ON "commercial_pack_records" ("workspace_id", ("data"->>'providerKey'), ("data"->>'idempotencyKey'))
  WHERE "collection" = 'paymentAttempts' AND "data"->>'idempotencyKey' IS NOT NULL;

CREATE UNIQUE INDEX "commercial_pack_refund_idempotency_uq"
  ON "commercial_pack_records" ("workspace_id", ("data"->>'paymentId'), ("data"->>'idempotencyKey'))
  WHERE "collection" = 'refunds' AND "data"->>'idempotencyKey' IS NOT NULL;

CREATE UNIQUE INDEX "commercial_pack_form_version_number_uq"
  ON "commercial_pack_records" ("workspace_id", ("data"->>'formId'), (("data"->>'versionNumber')::integer))
  WHERE "collection" = 'crmFormVersions';

CREATE UNIQUE INDEX "commercial_pack_customer_identity_uq"
  ON "commercial_pack_records" ("workspace_id", ("data"->>'connectionId'), ("data"->>'normalizedValue'))
  WHERE "collection" = 'customerChannelIdentities';

CREATE UNIQUE INDEX "commercial_pack_estimate_default_stage_uq"
  ON "commercial_pack_records" ("workspace_id", ("data"->>'semanticStatus'))
  WHERE "collection" = 'estimateStages' AND "data"->>'isDefault' = 'true' AND "data"->>'active' = 'true';
