CREATE TABLE commerce_payment_disputes (
 id UUID PRIMARY KEY, workspace_id UUID NOT NULL, store_id UUID NOT NULL, order_id UUID NOT NULL, payment_id UUID NOT NULL,
 connection_id UUID NOT NULL, provider_code TEXT NOT NULL, provider_dispute_id TEXT NOT NULL, charge_id TEXT NOT NULL,
 amount NUMERIC(24,6) NOT NULL, currency CHAR(3) NOT NULL, status TEXT NOT NULL, provider_status TEXT NOT NULL, reason TEXT NOT NULL,
 evidence JSONB NOT NULL, opened_at TIMESTAMPTZ(6) NOT NULL, resolved_at TIMESTAMPTZ(6),last_provider_at TIMESTAMPTZ(6) NOT NULL,version BIGINT NOT NULL DEFAULT 1,
 UNIQUE(workspace_id,id), UNIQUE(workspace_id,connection_id,provider_code,provider_dispute_id),
 FOREIGN KEY(workspace_id,store_id,order_id) REFERENCES commerce_orders(workspace_id,store_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id,connection_id) REFERENCES integration_outbound_connections(workspace_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(payment_id) REFERENCES commercial_pack_records(id) ON DELETE RESTRICT,
 CHECK(amount>0 AND currency ~ '^[A-Z]{3}$' AND version>0 AND length(provider_dispute_id) BETWEEN 1 AND 160 AND length(charge_id) BETWEEN 1 AND 160),
 CHECK(status IN ('OPEN','EVIDENCE_REQUIRED','SUBMITTED','WON','LOST') AND provider_status IN ('needs_response','under_review','won','lost','warning_needs_response','warning_under_review','warning_closed','prevented')),
 CHECK((status IN ('WON','LOST'))=(resolved_at IS NOT NULL) AND last_provider_at>=opened_at AND (resolved_at IS NULL OR resolved_at>=opened_at)),
 CHECK(reason IN ('bank_cannot_process','check_returned','credit_not_processed','customer_initiated','debit_not_authorized','duplicate','fraudulent','general','incorrect_account_details','insufficient_funds','noncompliant','product_not_received','product_unacceptable','subscription_canceled','unrecognized'))
);
CREATE INDEX commerce_dispute_list ON commerce_payment_disputes(workspace_id,store_id,status,opened_at);
CREATE FUNCTION commerce_dispute_evidence_valid(e JSONB) RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE AS $$
 SELECT jsonb_typeof(e)='object' AND e ?& ARRAY['hasEvidence','pastDue','submissionCount','dueAt']
 AND e - ARRAY['hasEvidence','pastDue','submissionCount','dueAt']='{}'::jsonb
 AND jsonb_typeof(e->'hasEvidence')='boolean' AND jsonb_typeof(e->'pastDue')='boolean'
 AND jsonb_typeof(e->'submissionCount')='number' AND (e->>'submissionCount') ~ '^[0-9]{1,6}$'
 AND (e->>'submissionCount')::integer BETWEEN 0 AND 100000
 AND (e->'dueAt'='null'::jsonb OR jsonb_typeof(e->'dueAt')='string' AND (e->>'dueAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$')
$$;
ALTER TABLE commerce_payment_disputes ADD CONSTRAINT commerce_dispute_evidence_shape CHECK(commerce_dispute_evidence_valid(evidence));
CREATE FUNCTION commerce_dispute_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PAYMENT_DISPUTE_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM commercial_pack_records p JOIN commerce_order_payment_bindings b ON b.payment_id=p.id AND b.workspace_id=p.workspace_id
 WHERE p.id=NEW.payment_id AND p.workspace_id=NEW.workspace_id AND p.collection='payments' AND p.data->>'flow'='COMMERCE'
 AND p.data->>'sourceOrderId'=NEW.order_id::text AND p.data->>'connectionId'=NEW.connection_id::text AND p.data->>'providerKey'=NEW.provider_code
 AND p.data->>'currencyCode'=NEW.currency AND b.order_id=NEW.order_id AND b.store_id=NEW.store_id)
 THEN RAISE EXCEPTION 'PAYMENT_DISPUTE_INVALID' USING ERRCODE='23503'; END IF;
 IF TG_OP='UPDATE' AND (ROW(NEW.id,NEW.workspace_id,NEW.store_id,NEW.order_id,NEW.payment_id,NEW.connection_id,NEW.provider_code,NEW.provider_dispute_id,NEW.charge_id,NEW.amount,NEW.currency,NEW.opened_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.store_id,OLD.order_id,OLD.payment_id,OLD.connection_id,OLD.provider_code,OLD.provider_dispute_id,OLD.charge_id,OLD.amount,OLD.currency,OLD.opened_at)
 OR NEW.last_provider_at<OLD.last_provider_at OR NEW.version<>OLD.version+1
 OR OLD.status IN ('WON','LOST') AND ROW(NEW.status,NEW.resolved_at) IS DISTINCT FROM ROW(OLD.status,OLD.resolved_at))
 THEN RAISE EXCEPTION 'PAYMENT_DISPUTE_IMMUTABLE' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER commerce_dispute_owner BEFORE INSERT OR UPDATE OR DELETE ON commerce_payment_disputes FOR EACH ROW EXECUTE FUNCTION commerce_dispute_guard();
CREATE TABLE commerce_payment_dispute_history (
 id UUID PRIMARY KEY,workspace_id UUID NOT NULL,dispute_id UUID NOT NULL,receipt_id UUID NOT NULL UNIQUE,provider_event_id TEXT NOT NULL,
 status TEXT NOT NULL,provider_status TEXT NOT NULL,evidence JSONB NOT NULL,outcome TEXT NOT NULL,occurred_at TIMESTAMPTZ(6) NOT NULL,
 FOREIGN KEY(workspace_id,dispute_id) REFERENCES commerce_payment_disputes(workspace_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(receipt_id) REFERENCES shared_payment_provider_events(id) ON DELETE RESTRICT,
 CHECK(status IN ('OPEN','EVIDENCE_REQUIRED','SUBMITTED','WON','LOST') AND outcome IN ('APPLIED','IGNORED','UNCHANGED') AND commerce_dispute_evidence_valid(evidence)),
 CHECK(provider_status IN ('needs_response','under_review','won','lost','warning_needs_response','warning_under_review','warning_closed','prevented'))
);
CREATE INDEX commerce_dispute_history ON commerce_payment_dispute_history(workspace_id,dispute_id,occurred_at);
CREATE FUNCTION commerce_dispute_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'PAYMENT_DISPUTE_HISTORY_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM shared_payment_provider_events e JOIN commerce_payment_disputes d ON d.workspace_id=e.workspace_id AND d.id=NEW.dispute_id
 WHERE e.id=NEW.receipt_id AND e.workspace_id=NEW.workspace_id AND e.external_event_id=NEW.provider_event_id AND e.signature_verified AND e.payment_id=d.payment_id
 AND e.connection_id=d.connection_id AND e.provider_code=d.provider_code AND e.normalized->>'kind'='DISPUTE' AND e.normalized->>'disputeId'=d.provider_dispute_id
 AND e.normalized->>'status'=NEW.status AND e.normalized->>'providerStatus'=NEW.provider_status AND e.normalized->'evidence'=NEW.evidence
 AND (e.normalized->>'occurredAt')::timestamptz=NEW.occurred_at)
 THEN RAISE EXCEPTION 'PAYMENT_DISPUTE_INVALID' USING ERRCODE='23503'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER commerce_dispute_history_owner BEFORE INSERT OR UPDATE OR DELETE ON commerce_payment_dispute_history FOR EACH ROW EXECUTE FUNCTION commerce_dispute_history_guard();
