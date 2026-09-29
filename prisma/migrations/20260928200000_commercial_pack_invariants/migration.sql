-- Database backstops for concurrency-sensitive Commercial/Capture/Contact-Center invariants.
CREATE UNIQUE INDEX "commercial_pack_requisite_default_uq"
  ON "commercial_pack_records" ("workspace_id", ("data"->>'ownerType'), ("data"->>'ownerId'))
  WHERE "collection" = 'requisites' AND "data"->>'isDefault' = 'true' AND "data"->>'active' = 'true';

CREATE UNIQUE INDEX "commercial_pack_bank_default_uq"
  ON "commercial_pack_records" ("workspace_id", ("data"->>'requisiteId'), COALESCE("data"->>'currencyCode', ''))
  WHERE "collection" = 'bankAccounts' AND "data"->>'isDefault' = 'true' AND "data"->>'active' = 'true';

CREATE UNIQUE INDEX "commercial_pack_seller_workspace_default_uq"
  ON "commercial_pack_records" ("workspace_id")
  WHERE "collection" = 'sellerCompanyBindings' AND "data"->>'isWorkspaceDefault' = 'true'
    AND "data"->>'active' = 'true' AND COALESCE("data"->>'contextKey', '') = '';

CREATE UNIQUE INDEX "commercial_pack_form_submission_idempotency_uq"
  ON "commercial_pack_records" ("workspace_id", ("data"->>'formId'), ("data"->>'formVersionId'), ("data"->>'idempotencyKey'))
  WHERE "collection" = 'crmFormSubmissions' AND "data"->>'idempotencyKey' IS NOT NULL;

CREATE UNIQUE INDEX "commercial_pack_form_binding_step_uq"
  ON "commercial_pack_records" ("workspace_id", ("data"->>'submissionId'), ("data"->>'recipeStepKey'))
  WHERE "collection" = 'crmFormEntityBindings';

CREATE UNIQUE INDEX "commercial_pack_outbound_client_message_uq"
  ON "commercial_pack_records" ("workspace_id", ("data"->>'conversationId'), ("data"->>'clientMessageId'))
  WHERE "collection" = 'conversationMessages' AND "data"->>'clientMessageId' IS NOT NULL;

CREATE UNIQUE INDEX "commercial_pack_external_message_uq"
  ON "commercial_pack_records" ("workspace_id", ("data"->>'connectionId'), ("data"->>'externalMessageId'))
  WHERE "collection" = 'conversationMessages' AND "data"->>'externalMessageId' IS NOT NULL;

CREATE UNIQUE INDEX "commercial_pack_background_job_key_uq"
  ON "commercial_pack_records" ("workspace_id", ("data"->>'key'))
  WHERE "collection" = 'backgroundJobs';
