CREATE TABLE commerce_refund_bindings (
 id UUID PRIMARY KEY,workspace_id UUID NOT NULL,store_id UUID NOT NULL,order_id UUID NOT NULL,payment_id UUID NOT NULL,refund_id UUID NOT NULL UNIQUE,
 return_id UUID,requested_by_user_id UUID NOT NULL,policy_snapshot JSONB NOT NULL,requires_approval BOOLEAN NOT NULL,created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(workspace_id,refund_id),
 FOREIGN KEY(workspace_id,store_id,order_id) REFERENCES commerce_orders(workspace_id,store_id,id),
 FOREIGN KEY(workspace_id,store_id,order_id,return_id) REFERENCES commerce_returns(workspace_id,store_id,order_id,id),
 FOREIGN KEY(payment_id) REFERENCES commercial_pack_records(id),FOREIGN KEY(refund_id) REFERENCES commercial_pack_records(id),
 FOREIGN KEY(workspace_id,requested_by_user_id) REFERENCES workspace_memberships(workspace_id,user_id)
);
CREATE INDEX commerce_refund_bindings_workspace_id_store_id_order_id_idx ON commerce_refund_bindings(workspace_id,store_id,order_id);
CREATE TABLE commerce_refund_approvals (
 id UUID PRIMARY KEY,workspace_id UUID NOT NULL,refund_id UUID NOT NULL,decided_by_user_id UUID NOT NULL,decision TEXT NOT NULL CHECK(decision IN ('APPROVE','REJECT')),
 reason TEXT NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),policy_snapshot JSONB NOT NULL,decided_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(workspace_id,refund_id),FOREIGN KEY(workspace_id,refund_id) REFERENCES commerce_refund_bindings(workspace_id,refund_id),
 FOREIGN KEY(workspace_id,decided_by_user_id) REFERENCES workspace_memberships(workspace_id,user_id)
);
CREATE TABLE commerce_refund_requests (
 id UUID PRIMARY KEY,workspace_id UUID NOT NULL,actor_user_id UUID NOT NULL,operation TEXT NOT NULL,key TEXT NOT NULL CHECK(length(key) BETWEEN 8 AND 128),
 request_hash TEXT NOT NULL,response JSONB NOT NULL,created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(workspace_id,actor_user_id,operation,key),FOREIGN KEY(workspace_id,actor_user_id) REFERENCES workspace_memberships(workspace_id,user_id)
);
CREATE TABLE shared_refund_commands (
 id UUID PRIMARY KEY,workspace_id UUID NOT NULL,refund_id UUID NOT NULL UNIQUE,payment_id UUID NOT NULL,actor_user_id UUID NOT NULL,
 status TEXT NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED','RUNNING','WAITING_CONFIRMATION','SUCCEEDED','FAILED')),
 attempts INT NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),uncertain BOOLEAN NOT NULL DEFAULT false,claim_token UUID,lease_expires_at TIMESTAMPTZ(6),
 next_attempt_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,last_error_code TEXT,created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(workspace_id,refund_id) REFERENCES commerce_refund_bindings(workspace_id,refund_id),FOREIGN KEY(payment_id) REFERENCES commercial_pack_records(id),
 FOREIGN KEY(workspace_id,actor_user_id) REFERENCES workspace_memberships(workspace_id,user_id),
 CHECK((status='RUNNING' AND claim_token IS NOT NULL AND lease_expires_at IS NOT NULL) OR (status<>'RUNNING' AND claim_token IS NULL AND lease_expires_at IS NULL))
);
CREATE INDEX shared_refund_commands_status_next_attempt_at_lease_expires_at_idx ON shared_refund_commands(status,next_attempt_at,lease_expires_at);
CREATE INDEX shared_refund_commands_workspace_id_payment_id_idx ON shared_refund_commands(workspace_id,payment_id);
CREATE TRIGGER commerce_refund_bindings_immutable BEFORE UPDATE OR DELETE ON commerce_refund_bindings FOR EACH ROW EXECUTE FUNCTION commerce_checkout_evidence_immutable();
CREATE TRIGGER commerce_refund_approvals_immutable BEFORE UPDATE OR DELETE ON commerce_refund_approvals FOR EACH ROW EXECUTE FUNCTION commerce_checkout_evidence_immutable();
CREATE TRIGGER commerce_refund_requests_immutable BEFORE UPDATE OR DELETE ON commerce_refund_requests FOR EACH ROW EXECUTE FUNCTION commerce_checkout_evidence_immutable();
CREATE FUNCTION commerce_refund_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p JSONB;r JSONB;
BEGIN
 SELECT data INTO p FROM commercial_pack_records WHERE id=NEW.payment_id AND workspace_id=NEW.workspace_id AND collection='payments';
 SELECT data INTO r FROM commercial_pack_records WHERE id=NEW.refund_id AND workspace_id=NEW.workspace_id AND collection='refunds';
 IF p->>'flow' IS DISTINCT FROM 'COMMERCE' OR p->>'sourceOrderId' IS DISTINCT FROM NEW.order_id::text OR r->>'flow' IS DISTINCT FROM 'COMMERCE' OR r->>'paymentId' IS DISTINCT FROM NEW.payment_id::text OR r->>'orderId' IS DISTINCT FROM NEW.order_id::text OR r->>'currencyCode' IS DISTINCT FROM p->>'currencyCode' THEN RAISE EXCEPTION 'REFUND_BINDING_INVALID' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER commerce_refund_binding_owner BEFORE INSERT ON commerce_refund_bindings FOR EACH ROW EXECUTE FUNCTION commerce_refund_binding_guard();
CREATE FUNCTION managed_refund_record_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p JSONB;
BEGIN
 IF TG_OP<>'INSERT' AND OLD.collection='refunds' AND OLD.data->>'flow'='COMMERCE' THEN
  IF TG_OP='DELETE' OR ROW(NEW.id,NEW.workspace_id,NEW.collection,NEW.data->>'id',NEW.data->>'workspaceId',NEW.data->>'flow',NEW.data->>'orderId',NEW.data->>'paymentId',NEW.data->>'currencyCode',NEW.data->>'amount',NEW.data->>'requestedByUserId',NEW.data->>'reasonText',NEW.data->>'requestedAt') IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.collection,OLD.data->>'id',OLD.data->>'workspaceId',OLD.data->>'flow',OLD.data->>'orderId',OLD.data->>'paymentId',OLD.data->>'currencyCode',OLD.data->>'amount',OLD.data->>'requestedByUserId',OLD.data->>'reasonText',OLD.data->>'requestedAt') OR (OLD.data->>'providerRefundId' IS NOT NULL AND NEW.data->>'providerRefundId' IS DISTINCT FROM OLD.data->>'providerRefundId') OR (OLD.data->>'status' IN ('SUCCEEDED','CANCELLED') AND NEW.data->>'status' IS DISTINCT FROM OLD.data->>'status') THEN RAISE EXCEPTION 'REFUND_IMMUTABLE' USING ERRCODE='23514'; END IF;
 END IF;
 IF TG_OP<>'DELETE' AND NEW.collection='refunds' AND NEW.data->>'flow'='COMMERCE' THEN
  SELECT data INTO p FROM commercial_pack_records WHERE id=(NEW.data->>'paymentId')::uuid AND workspace_id=NEW.workspace_id AND collection='payments' FOR UPDATE;
  IF p->>'flow' IS DISTINCT FROM 'COMMERCE' OR p->>'sourceOrderId' IS DISTINCT FROM NEW.data->>'orderId' OR p->>'currencyCode' IS DISTINCT FROM NEW.data->>'currencyCode' OR NEW.data->>'id' IS DISTINCT FROM NEW.id::text OR NEW.data->>'workspaceId' IS DISTINCT FROM NEW.workspace_id::text OR (NEW.data->>'amount')::numeric<=0 OR NOT (NEW.data ?& ARRAY['amount','currencyCode','requestedByUserId','reasonText','requestedAt','status','version']) OR NEW.data->>'status' NOT IN ('PENDING_APPROVAL','APPROVED','PROCESSING','SUCCEEDED','FAILED','CANCELLED') OR (NEW.data->>'version')::bigint<=0 THEN RAISE EXCEPTION 'REFUND_INVALID_STATE' USING ERRCODE='23514'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;RETURN NEW;
END $$;
CREATE TRIGGER managed_refund_record BEFORE INSERT OR UPDATE OR DELETE ON commercial_pack_records FOR EACH ROW EXECUTE FUNCTION managed_refund_record_guard();
CREATE UNIQUE INDEX managed_refund_provider_identity ON commercial_pack_records(workspace_id,(data->>'paymentId'),(data->>'providerRefundId')) WHERE collection='refunds' AND data->>'flow'='COMMERCE' AND data->>'providerRefundId' IS NOT NULL;
-- Successful and all held requests compete against the same captured funds;
-- Invoice allocations also reduce the pool. Order allocation is adjusted only
-- after provider success and is checked by the existing deferred ledger guard.
CREATE FUNCTION managed_refund_fund_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ws UUID;pid UUID;p JSONB;held NUMERIC;invoiced NUMERIC;
BEGIN
 IF NEW.collection NOT IN ('payments','refunds','paymentAllocations') THEN RETURN NULL; END IF;
 ws:=NEW.workspace_id;pid:=CASE WHEN NEW.collection='payments' THEN NEW.id ELSE (NEW.data->>'paymentId')::uuid END;
 SELECT data INTO p FROM commercial_pack_records WHERE workspace_id=ws AND id=pid AND collection='payments' FOR UPDATE;
 IF p->>'flow' IS DISTINCT FROM 'COMMERCE' THEN RETURN NULL; END IF;
 SELECT COALESCE(sum((data->>'amount')::numeric),0) INTO held FROM commercial_pack_records WHERE workspace_id=ws AND collection='refunds' AND data->>'paymentId'=pid::text AND data->>'status' NOT IN ('FAILED','CANCELLED');
 SELECT COALESCE(sum((data->>'amount')::numeric),0) INTO invoiced FROM commercial_pack_records WHERE workspace_id=ws AND collection='paymentAllocations' AND data->>'paymentId'=pid::text AND data->>'status'='ACTIVE';
 IF held+invoiced>(p->>'capturedAmount')::numeric THEN RAISE EXCEPTION 'REFUND_AMOUNT_EXCEEDED' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER managed_refund_funds AFTER INSERT OR UPDATE ON commercial_pack_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION managed_refund_fund_guard();
