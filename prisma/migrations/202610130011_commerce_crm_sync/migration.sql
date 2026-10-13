CREATE TABLE commerce_crm_sync (
 id UUID PRIMARY KEY,workspace_id UUID NOT NULL,store_id UUID NOT NULL,order_id UUID NOT NULL,deal_policy TEXT NOT NULL,
 mode TEXT NOT NULL DEFAULT 'AUTO',requested_by_user_id UUID,status TEXT NOT NULL DEFAULT 'QUEUED',attempts INTEGER NOT NULL DEFAULT 0,cycle_attempts INTEGER NOT NULL DEFAULT 0,
 customer_was_new BOOLEAN,deal_created BOOLEAN,claim_token UUID,lease_expires_at TIMESTAMPTZ(6),next_attempt_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 error_code TEXT,version BIGINT NOT NULL DEFAULT 1,created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,completed_at TIMESTAMPTZ(6),
 UNIQUE(workspace_id,order_id),UNIQUE(workspace_id,id),
 FOREIGN KEY(workspace_id,store_id,order_id) REFERENCES commerce_orders(workspace_id,store_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(requested_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
 CHECK(deal_policy IN ('ALWAYS','NEVER','ONLY_NEW_CUSTOMER','MANUAL_REVIEW') AND mode IN ('AUTO','MANUAL') AND status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','REVIEW_REQUIRED')),
 CHECK(mode<>'MANUAL' OR requested_by_user_id IS NOT NULL),CHECK(attempts>=0 AND cycle_attempts BETWEEN 0 AND 5 AND version>0),
 CHECK(status='RUNNING' AND claim_token IS NOT NULL AND lease_expires_at IS NOT NULL OR status<>'RUNNING' AND claim_token IS NULL AND lease_expires_at IS NULL),
 CHECK(error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,99}$'),CHECK(status<>'SUCCEEDED' OR customer_was_new IS NOT NULL AND deal_created IS NOT NULL AND error_code IS NULL)
);
CREATE INDEX commerce_crm_sync_order_fk ON commerce_crm_sync(workspace_id,store_id,order_id);
CREATE INDEX commerce_crm_sync_principal_fk ON commerce_crm_sync(requested_by_user_id);
CREATE INDEX commerce_crm_sync_due ON commerce_crm_sync(status,next_attempt_at,lease_expires_at);
CREATE FUNCTION commerce_crm_sync_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'COMMERCE_CRM_SYNC_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF NEW.requested_by_user_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM workspace_memberships WHERE workspace_id=NEW.workspace_id AND user_id=NEW.requested_by_user_id)
 THEN RAISE EXCEPTION 'COMMERCE_CRM_SYNC_PRINCIPAL_INVALID' USING ERRCODE='23503'; END IF;
 IF TG_OP='UPDATE' AND (ROW(NEW.id,NEW.workspace_id,NEW.store_id,NEW.order_id,NEW.deal_policy,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.store_id,OLD.order_id,OLD.deal_policy,OLD.created_at)
 OR NEW.attempts<OLD.attempts OR NEW.version<>OLD.version+1 OR OLD.status='SUCCEEDED' AND NEW IS DISTINCT FROM OLD)
 THEN RAISE EXCEPTION 'COMMERCE_CRM_SYNC_IMMUTABLE' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER commerce_crm_sync_owner BEFORE INSERT OR UPDATE OR DELETE ON commerce_crm_sync FOR EACH ROW EXECUTE FUNCTION commerce_crm_sync_guard();
CREATE TABLE commerce_crm_sync_requests (
 id UUID PRIMARY KEY,workspace_id UUID NOT NULL,sync_id UUID NOT NULL,actor_user_id UUID NOT NULL,request_key TEXT NOT NULL,request_hash TEXT NOT NULL,response JSONB NOT NULL,
 UNIQUE(workspace_id,actor_user_id,request_key),FOREIGN KEY(workspace_id,sync_id) REFERENCES commerce_crm_sync(workspace_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,CHECK(length(request_key) BETWEEN 8 AND 128 AND request_hash ~ '^[a-f0-9]{64}$')
);
CREATE INDEX commerce_crm_request_sync_fk ON commerce_crm_sync_requests(workspace_id,sync_id);
CREATE INDEX commerce_crm_request_actor_fk ON commerce_crm_sync_requests(actor_user_id);
CREATE TABLE commerce_crm_sync_history (
 id UUID PRIMARY KEY,workspace_id UUID NOT NULL,sync_id UUID NOT NULL,action TEXT NOT NULL,actor_user_id UUID,error_code TEXT,attempt INTEGER NOT NULL,occurred_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(workspace_id,sync_id) REFERENCES commerce_crm_sync(workspace_id,id) ON DELETE RESTRICT,FOREIGN KEY(actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
 CHECK(action IN ('QUEUED','CLAIMED','SUCCEEDED','RETRY','FAILED','REVIEW_REQUIRED') AND attempt>=0),CHECK(error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,99}$')
);
CREATE INDEX commerce_crm_history_sync_fk ON commerce_crm_sync_history(workspace_id,sync_id,occurred_at);
CREATE INDEX commerce_crm_history_actor_fk ON commerce_crm_sync_history(actor_user_id);
CREATE FUNCTION commerce_crm_sync_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'COMMERCE_CRM_SYNC_EVIDENCE_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF NEW.actor_user_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM workspace_memberships WHERE workspace_id=NEW.workspace_id AND user_id=NEW.actor_user_id)
 THEN RAISE EXCEPTION 'COMMERCE_CRM_SYNC_PRINCIPAL_INVALID' USING ERRCODE='23503'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER commerce_crm_request_evidence BEFORE INSERT OR UPDATE OR DELETE ON commerce_crm_sync_requests FOR EACH ROW EXECUTE FUNCTION commerce_crm_sync_evidence_guard();
CREATE TRIGGER commerce_crm_history_evidence BEFORE INSERT OR UPDATE OR DELETE ON commerce_crm_sync_history FOR EACH ROW EXECUTE FUNCTION commerce_crm_sync_evidence_guard();
CREATE UNIQUE INDEX crm_commerce_order_deal_identity ON crm_deals(workspace_id,origin_external_id) WHERE origin_system='COMMERCE';
CREATE FUNCTION crm_commerce_order_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.origin_system='COMMERCE' AND NOT EXISTS(SELECT 1 FROM commerce_orders WHERE workspace_id=NEW.workspace_id AND id::text=NEW.origin_external_id)
 THEN RAISE EXCEPTION 'COMMERCE_CRM_DEAL_SOURCE_INVALID' USING ERRCODE='23503'; END IF;
 IF TG_OP='UPDATE' AND OLD.origin_system='COMMERCE' AND ROW(NEW.workspace_id,NEW.origin_system,NEW.origin_external_id) IS DISTINCT FROM ROW(OLD.workspace_id,OLD.origin_system,OLD.origin_external_id)
 THEN RAISE EXCEPTION 'COMMERCE_CRM_DEAL_SOURCE_IMMUTABLE' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crm_commerce_order_source BEFORE INSERT OR UPDATE ON crm_deals FOR EACH ROW EXECUTE FUNCTION crm_commerce_order_source_guard();
