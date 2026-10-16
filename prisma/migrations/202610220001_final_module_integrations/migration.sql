ALTER TABLE billing_accounts ADD COLUMN provider_customers jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE ai_runs ADD COLUMN stream_sealed text;

CREATE TABLE platform_external_emails (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  resource_type text NOT NULL,
  resource_id uuid NOT NULL,
  message_sealed text,
  state text NOT NULL DEFAULT 'QUEUED',
  provider_message_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_external_emails_workspace_resource ON platform_external_emails(workspace_id, resource_type, resource_id);
