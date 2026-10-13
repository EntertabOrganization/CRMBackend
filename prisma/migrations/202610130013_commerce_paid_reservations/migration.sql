CREATE TABLE commerce_paid_reservation_jobs (
 id UUID PRIMARY KEY,workspace_id UUID NOT NULL,store_id UUID NOT NULL,order_id UUID NOT NULL,policy TEXT NOT NULL DEFAULT 'PAYMENT_PAID',
 status TEXT NOT NULL DEFAULT 'WAITING',correlation_id UUID NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,
 claim_token UUID,lease_expires_at TIMESTAMPTZ(6),next_attempt_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 error_code TEXT,version BIGINT NOT NULL DEFAULT 1,created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,completed_at TIMESTAMPTZ(6),
 UNIQUE(workspace_id,order_id),FOREIGN KEY(workspace_id,store_id,order_id) REFERENCES commerce_orders(workspace_id,store_id,id) ON DELETE RESTRICT,
 CHECK(policy='PAYMENT_PAID' AND status IN ('WAITING','QUEUED','RUNNING','SUCCEEDED','FAILED')),
 CHECK(attempts BETWEEN 0 AND 5 AND version>0),CHECK(error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,99}$'),
 CHECK(status='RUNNING' AND claim_token IS NOT NULL AND lease_expires_at IS NOT NULL OR status<>'RUNNING' AND claim_token IS NULL AND lease_expires_at IS NULL),
 CHECK(status NOT IN ('SUCCEEDED','FAILED') OR completed_at IS NOT NULL)
);
CREATE INDEX commerce_paid_reservation_order_fk ON commerce_paid_reservation_jobs(workspace_id,store_id,order_id);
CREATE INDEX commerce_paid_reservation_due ON commerce_paid_reservation_jobs(status,next_attempt_at,lease_expires_at);
CREATE FUNCTION commerce_paid_reservation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'COMMERCE_PAID_RESERVATION_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND (ROW(NEW.id,NEW.workspace_id,NEW.store_id,NEW.order_id,NEW.policy,NEW.correlation_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.store_id,OLD.order_id,OLD.policy,OLD.correlation_id,OLD.created_at)
 OR NEW.version<>OLD.version+1 OR NEW.attempts<OLD.attempts OR OLD.status IN ('SUCCEEDED','FAILED') AND NEW IS DISTINCT FROM OLD)
 THEN RAISE EXCEPTION 'COMMERCE_PAID_RESERVATION_IMMUTABLE' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER commerce_paid_reservation_owner BEFORE INSERT OR UPDATE OR DELETE ON commerce_paid_reservation_jobs FOR EACH ROW EXECUTE FUNCTION commerce_paid_reservation_guard();
