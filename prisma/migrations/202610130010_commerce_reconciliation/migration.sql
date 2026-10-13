CREATE TABLE commerce_crm_bindings (
 id UUID PRIMARY KEY,workspace_id UUID NOT NULL,store_id UUID NOT NULL,order_id UUID NOT NULL,entity_type TEXT NOT NULL,target_id UUID,
 link_policy TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'PENDING',last_error_code TEXT,version BIGINT NOT NULL DEFAULT 1,
 UNIQUE(workspace_id,order_id,entity_type),
 FOREIGN KEY(workspace_id,store_id,order_id) REFERENCES commerce_orders(workspace_id,store_id,id) ON DELETE RESTRICT,
 CHECK(entity_type IN ('CONTACT','COMPANY','DEAL') AND link_policy IN ('ALWAYS','NEVER','ONLY_NEW_CUSTOMER','MANUAL_REVIEW') AND status IN ('PENDING','LINKED','FAILED') AND version>0),
 CHECK(status<>'LINKED' OR target_id IS NOT NULL),CHECK(last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,99}$')
);
CREATE INDEX commerce_crm_binding_order_fk ON commerce_crm_bindings(workspace_id,store_id,order_id);
CREATE INDEX commerce_crm_binding_target ON commerce_crm_bindings(entity_type,target_id);
CREATE FUNCTION commerce_crm_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'COMMERCE_CRM_BINDING_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF NEW.target_id IS NOT NULL AND NOT (
  NEW.entity_type='CONTACT' AND EXISTS(SELECT 1 FROM crm_contacts WHERE id=NEW.target_id AND workspace_id=NEW.workspace_id) OR
  NEW.entity_type='COMPANY' AND EXISTS(SELECT 1 FROM crm_companies WHERE id=NEW.target_id AND workspace_id=NEW.workspace_id) OR
  NEW.entity_type='DEAL' AND EXISTS(SELECT 1 FROM crm_deals WHERE id=NEW.target_id AND workspace_id=NEW.workspace_id))
 THEN RAISE EXCEPTION 'COMMERCE_CRM_BINDING_INVALID' USING ERRCODE='23503'; END IF;
 IF TG_OP='UPDATE' AND (ROW(NEW.id,NEW.workspace_id,NEW.store_id,NEW.order_id,NEW.entity_type,NEW.link_policy) IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.store_id,OLD.order_id,OLD.entity_type,OLD.link_policy) OR NEW.version<>OLD.version+1)
 THEN RAISE EXCEPTION 'COMMERCE_CRM_BINDING_IMMUTABLE' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER commerce_crm_binding_owner BEFORE INSERT OR UPDATE OR DELETE ON commerce_crm_bindings FOR EACH ROW EXECUTE FUNCTION commerce_crm_binding_guard();
CREATE TABLE commerce_reconciliation_jobs (
 id UUID PRIMARY KEY,workspace_id UUID NOT NULL,store_id UUID NOT NULL,order_id UUID NOT NULL,requested_by_user_id UUID NOT NULL,
 idempotency_key TEXT NOT NULL,request_hash TEXT NOT NULL,correlation_id UUID NOT NULL,status TEXT NOT NULL DEFAULT 'QUEUED',attempts INTEGER NOT NULL DEFAULT 0,
 claim_token UUID,lease_expires_at TIMESTAMPTZ(6),next_attempt_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,result JSONB,error_code TEXT,
 created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,completed_at TIMESTAMPTZ(6),
 UNIQUE(workspace_id,requested_by_user_id,idempotency_key),
 FOREIGN KEY(workspace_id,store_id,order_id) REFERENCES commerce_orders(workspace_id,store_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(requested_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
 CHECK(length(idempotency_key) BETWEEN 8 AND 128 AND request_hash ~ '^[a-f0-9]{64}$' AND status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED') AND attempts BETWEEN 0 AND 5),
 CHECK(status='RUNNING' AND claim_token IS NOT NULL AND lease_expires_at IS NOT NULL AND attempts>0 OR status<>'RUNNING' AND claim_token IS NULL AND lease_expires_at IS NULL),
 CHECK((status IN ('SUCCEEDED','FAILED'))=(completed_at IS NOT NULL)),
 CHECK((status='SUCCEEDED')=(result IS NOT NULL)),
 CHECK(status<>'SUCCEEDED' OR attempts>0 AND error_code IS NULL),
 CHECK(status<>'FAILED' OR error_code IS NOT NULL),
 CHECK(completed_at IS NULL OR completed_at>=created_at),
 CHECK(error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,99}$')
);
CREATE INDEX commerce_reconciliation_order_fk ON commerce_reconciliation_jobs(workspace_id,store_id,order_id);
CREATE INDEX commerce_reconciliation_due ON commerce_reconciliation_jobs(status,next_attempt_at,lease_expires_at);
CREATE INDEX commerce_reconciliation_principal_fk ON commerce_reconciliation_jobs(requested_by_user_id);
CREATE FUNCTION commerce_reconciliation_job_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'COMMERCE_RECONCILIATION_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM workspace_memberships WHERE workspace_id=NEW.workspace_id AND user_id=NEW.requested_by_user_id)
 THEN RAISE EXCEPTION 'COMMERCE_RECONCILIATION_PRINCIPAL_INVALID' USING ERRCODE='23503'; END IF;
 IF NEW.result IS NOT NULL AND (jsonb_typeof(NEW.result)<>'object' OR NEW.result - ARRAY['orderId','orderVersion','observedAt','consistent','mismatches','checked','references']<>'{}'::jsonb
 OR NOT NEW.result ?& ARRAY['orderId','orderVersion','observedAt','consistent','mismatches','checked','references'] OR NEW.result->>'orderId'<>NEW.order_id::text
 OR jsonb_typeof(NEW.result->'consistent')<>'boolean' OR jsonb_typeof(NEW.result->'mismatches')<>'array' OR jsonb_typeof(NEW.result->'references')<>'object')
 THEN RAISE EXCEPTION 'COMMERCE_RECONCILIATION_RESULT_INVALID' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND (ROW(NEW.id,NEW.workspace_id,NEW.store_id,NEW.order_id,NEW.requested_by_user_id,NEW.idempotency_key,NEW.request_hash,NEW.correlation_id,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.store_id,OLD.order_id,OLD.requested_by_user_id,OLD.idempotency_key,OLD.request_hash,OLD.correlation_id,OLD.created_at)
 OR NEW.attempts<OLD.attempts OR OLD.status IN ('SUCCEEDED','FAILED') AND NEW IS DISTINCT FROM OLD)
 THEN RAISE EXCEPTION 'COMMERCE_RECONCILIATION_IMMUTABLE' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER commerce_reconciliation_owner BEFORE INSERT OR UPDATE OR DELETE ON commerce_reconciliation_jobs FOR EACH ROW EXECUTE FUNCTION commerce_reconciliation_job_guard();
