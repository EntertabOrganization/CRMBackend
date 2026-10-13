ALTER TABLE commerce_order_payment_bindings ADD COLUMN requested_amount NUMERIC(24,6);
ALTER TABLE commerce_order_payment_bindings DROP CONSTRAINT order_payment_amount_check;
ALTER TABLE commerce_order_payment_bindings ADD CONSTRAINT order_payment_amount_check CHECK
 (amount>=0 AND ((requested_amount IS NULL AND amount>0) OR (requested_amount>0 AND amount<=requested_amount)));
CREATE TABLE shared_payment_commands (
 id UUID PRIMARY KEY,workspace_id UUID NOT NULL,payment_id UUID NOT NULL,actor_user_id UUID NOT NULL,
 connection_id UUID NOT NULL,method_id UUID NOT NULL,provider_key TEXT NOT NULL,merchant_id TEXT NOT NULL,
 request_scope TEXT NOT NULL,request_key TEXT NOT NULL,request_hash TEXT NOT NULL,
 kind TEXT NOT NULL,amount NUMERIC(24,6) NOT NULL,currency CHAR(3) NOT NULL,reason TEXT,
 status TEXT NOT NULL DEFAULT 'QUEUED',attempts INTEGER NOT NULL DEFAULT 0,uncertain BOOLEAN NOT NULL DEFAULT false,
 claim_token UUID,lease_expires_at TIMESTAMPTZ(6),next_attempt_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 last_error_code TEXT,created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TIMESTAMPTZ(6) NOT NULL,
 CONSTRAINT shared_payment_command_shape CHECK(length(request_key) BETWEEN 8 AND 128 AND length(request_scope) BETWEEN 1 AND 100 AND request_hash ~ '^[a-f0-9]{64}$' AND kind IN ('SALE','AUTHORIZE','CAPTURE','VOID') AND
   status IN ('QUEUED','RUNNING','WAITING_CONFIRMATION','SUCCEEDED','FAILED') AND attempts BETWEEN 0 AND 5 AND
   ((kind='VOID' AND amount=0) OR (kind<>'VOID' AND amount>0)) AND
   ((status='RUNNING' AND claim_token IS NOT NULL AND lease_expires_at IS NOT NULL) OR (status<>'RUNNING' AND claim_token IS NULL AND lease_expires_at IS NULL))),
 CONSTRAINT shared_payment_command_payment_fk FOREIGN KEY(payment_id) REFERENCES commercial_pack_records(id) ON DELETE RESTRICT,
 CONSTRAINT shared_payment_command_actor_fk FOREIGN KEY(workspace_id,actor_user_id) REFERENCES workspace_memberships(workspace_id,user_id) ON DELETE RESTRICT,
 CONSTRAINT shared_payment_command_connection_fk FOREIGN KEY(workspace_id,connection_id) REFERENCES integration_outbound_connections(workspace_id,id) ON DELETE RESTRICT
);
CREATE INDEX shared_payment_command_due ON shared_payment_commands(status,next_attempt_at);
CREATE INDEX shared_payment_command_payment ON shared_payment_commands(workspace_id,payment_id,status);
CREATE UNIQUE INDEX shared_payment_command_request ON shared_payment_commands(workspace_id,actor_user_id,request_scope,request_key);
CREATE FUNCTION shared_payment_command_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PAYMENT_COMMAND_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM commercial_pack_records p WHERE p.id=NEW.payment_id AND p.workspace_id=NEW.workspace_id AND p.collection='payments')
 THEN RAISE EXCEPTION 'PAYMENT_NOT_FOUND' USING ERRCODE='23503'; END IF;
 IF TG_OP='UPDATE' AND (ROW(NEW.id,NEW.workspace_id,NEW.payment_id,NEW.actor_user_id,NEW.connection_id,NEW.method_id,NEW.provider_key,NEW.merchant_id,NEW.request_scope,NEW.request_key,NEW.request_hash,NEW.kind,NEW.amount,NEW.currency,NEW.reason,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.payment_id,OLD.actor_user_id,OLD.connection_id,OLD.method_id,OLD.provider_key,OLD.merchant_id,OLD.request_scope,OLD.request_key,OLD.request_hash,OLD.kind,OLD.amount,OLD.currency,OLD.reason,OLD.created_at)
   OR NEW.attempts<OLD.attempts)
 THEN RAISE EXCEPTION 'PAYMENT_COMMAND_IMMUTABLE' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER shared_payment_command_owner BEFORE INSERT OR UPDATE OR DELETE ON shared_payment_commands FOR EACH ROW EXECUTE FUNCTION shared_payment_command_guard();

CREATE FUNCTION managed_payment_record_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE requested numeric; authorized numeric; captured numeric;
BEGIN
 IF TG_OP<>'INSERT' AND OLD.collection='payments' AND OLD.data->>'flow'='COMMERCE' THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PAYMENT_IMMUTABLE' USING ERRCODE='23514'; END IF;
  IF ROW(NEW.id,NEW.workspace_id,NEW.collection,NEW.data->>'id',NEW.data->>'workspaceId',NEW.data->>'flow',NEW.data->>'sourceOrderId',NEW.data->>'currencyCode',NEW.data->>'requestedAmount',NEW.data->>'responsibleUserId',NEW.data->>'providerKey',NEW.data->>'merchantId',NEW.data->>'connectionId',NEW.data->>'methodId')
   IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.collection,OLD.data->>'id',OLD.data->>'workspaceId',OLD.data->>'flow',OLD.data->>'sourceOrderId',OLD.data->>'currencyCode',OLD.data->>'requestedAmount',OLD.data->>'responsibleUserId',OLD.data->>'providerKey',OLD.data->>'merchantId',OLD.data->>'connectionId',OLD.data->>'methodId')
   OR ((OLD.data->>'providerTransactionId') IS NOT NULL AND NEW.data->>'providerTransactionId' IS DISTINCT FROM OLD.data->>'providerTransactionId')
   OR (NEW.data->>'capturedAmount')::numeric<(OLD.data->>'capturedAmount')::numeric
  THEN RAISE EXCEPTION 'PAYMENT_IMMUTABLE' USING ERRCODE='23514'; END IF;
 END IF;
 IF TG_OP<>'DELETE' AND NEW.collection='payments' AND NEW.data->>'flow'='COMMERCE' THEN
  requested:=(NEW.data->>'requestedAmount')::numeric;authorized:=(NEW.data->>'authorizedAmount')::numeric;captured:=(NEW.data->>'capturedAmount')::numeric;
  IF NOT (NEW.data ?& ARRAY['id','workspaceId','sourceOrderId','currencyCode','amount','requestedAmount','authorizedAmount','capturedAmount','financialState','settlementStatus','responsibleUserId','providerKey','merchantId','connectionId','methodId'])
    OR requested IS NULL OR authorized IS NULL OR captured IS NULL OR requested<=0 OR authorized<captured OR captured<0 OR authorized>requested
    OR NEW.data->>'id' IS DISTINCT FROM NEW.id::text OR NEW.data->>'workspaceId' IS DISTINCT FROM NEW.workspace_id::text
    OR NEW.data->>'financialState' IS NULL OR NEW.data->>'financialState' NOT IN ('CREATED','PENDING','AUTHORIZED','PARTIALLY_CAPTURED','PAID','VOIDED','FAILED')
    OR NEW.data->>'settlementStatus' IS NULL OR NEW.data->>'settlementStatus' NOT IN ('PENDING','SUCCEEDED','FAILED','CANCELLED')
    OR (NEW.data->>'financialState' IN ('CREATED','PENDING','AUTHORIZED','VOIDED','FAILED') AND captured<>0)
    OR (NEW.data->>'financialState'='AUTHORIZED' AND authorized<=0)
    OR (NEW.data->>'financialState'='VOIDED' AND authorized<>0)
    OR (NEW.data->>'financialState'='PARTIALLY_CAPTURED' AND (captured<=0 OR captured>=requested))
    OR (NEW.data->>'financialState'='PAID' AND captured<>requested)
    OR (NEW.data->>'amount') IS NULL OR (captured>0 AND ((NEW.data->>'amount')::numeric<>captured OR NEW.data->>'settlementStatus'<>'SUCCEEDED'))
    OR (captured=0 AND NEW.data->>'settlementStatus'='SUCCEEDED')
    OR NEW.data ?| ARRAY['pan','cvv','cardNumber','providerCredential','apiKey','webhookSecret','clientSecret']
  THEN RAISE EXCEPTION 'PAYMENT_INVALID_STATE' USING ERRCODE='23514'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER managed_payment_record BEFORE INSERT OR UPDATE OR DELETE ON commercial_pack_records FOR EACH ROW EXECUTE FUNCTION managed_payment_record_guard();
CREATE UNIQUE INDEX managed_payment_transaction ON commercial_pack_records(workspace_id,(data->>'connectionId'),(data->>'providerKey'),(data->>'providerTransactionId'))
 WHERE collection='payments' AND data->>'flow'='COMMERCE' AND data->>'providerTransactionId' IS NOT NULL;

CREATE FUNCTION managed_order_payment_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p jsonb;
BEGIN
 IF TG_OP<>'INSERT' AND OLD.requested_amount IS NOT NULL THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PAYMENT_BINDING_IMMUTABLE' USING ERRCODE='23514'; END IF;
  IF ROW(NEW.workspace_id,NEW.store_id,NEW.order_id,NEW.payment_id,NEW.requested_amount) IS DISTINCT FROM ROW(OLD.workspace_id,OLD.store_id,OLD.order_id,OLD.payment_id,OLD.requested_amount)
  THEN RAISE EXCEPTION 'PAYMENT_BINDING_IMMUTABLE' USING ERRCODE='23514'; END IF;
 END IF;
 IF TG_OP<>'DELETE' THEN
  SELECT data INTO p FROM commercial_pack_records WHERE id=NEW.payment_id AND workspace_id=NEW.workspace_id AND collection='payments';
  IF p->>'flow'='COMMERCE' AND (NEW.requested_amount IS NULL OR NEW.requested_amount<>(p->>'requestedAmount')::numeric OR NEW.order_id::text IS DISTINCT FROM p->>'sourceOrderId' OR NEW.amount>(p->>'capturedAmount')::numeric)
  THEN RAISE EXCEPTION 'PAYMENT_BINDING_INVALID' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF; RETURN OLD;
END $$;
CREATE TRIGGER managed_order_payment_binding BEFORE INSERT OR UPDATE OR DELETE ON commerce_order_payment_bindings FOR EACH ROW EXECUTE FUNCTION managed_order_payment_binding_guard();
CREATE UNIQUE INDEX managed_order_payment_single_source ON commerce_order_payment_bindings(payment_id) WHERE requested_amount IS NOT NULL;
