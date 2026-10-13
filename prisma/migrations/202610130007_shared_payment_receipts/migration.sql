ALTER TABLE shared_payment_commands ADD COLUMN baseline_captured_amount NUMERIC(24,6) NOT NULL DEFAULT 0;
ALTER TABLE commerce_orders ADD COLUMN paid_amount NUMERIC(24,6) NOT NULL DEFAULT 0;
ALTER TABLE commerce_orders ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'UNPAID';
ALTER TABLE commerce_orders ADD CONSTRAINT commerce_order_payment_projection CHECK(paid_amount>=0 AND paid_amount<=total AND payment_status IN ('UNPAID','PARTIALLY_PAID','PAID'));
ALTER TABLE shared_payment_commands ADD CONSTRAINT payment_capture_baseline CHECK(baseline_captured_amount>=0);
CREATE TABLE shared_payment_provider_events (
 id UUID PRIMARY KEY,workspace_id UUID NOT NULL,connection_id UUID NOT NULL,provider_code TEXT NOT NULL,external_event_id TEXT NOT NULL,
 payment_id UUID,payload_hash TEXT NOT NULL,normalized JSONB NOT NULL,signature_verified BOOLEAN NOT NULL DEFAULT true,
 status TEXT NOT NULL DEFAULT 'QUEUED',outcome TEXT,attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,error_code TEXT,
 received_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,processed_at TIMESTAMPTZ(6),
 CONSTRAINT payment_receipt_connection_fk FOREIGN KEY(workspace_id,connection_id) REFERENCES integration_outbound_connections(workspace_id,id) ON DELETE RESTRICT,
 CONSTRAINT payment_receipt_record_fk FOREIGN KEY(payment_id) REFERENCES commercial_pack_records(id) ON DELETE RESTRICT,
 CONSTRAINT payment_receipt_shape CHECK(signature_verified AND payload_hash ~ '^[a-f0-9]{64}$' AND status IN ('QUEUED','SUCCEEDED','FAILED') AND attempts BETWEEN 0 AND 5 AND
   length(external_event_id) BETWEEN 1 AND 160 AND (outcome IS NULL OR outcome IN ('APPLIED','IGNORED','UNCHANGED')))
);
CREATE UNIQUE INDEX payment_receipt_external_identity ON shared_payment_provider_events(workspace_id,connection_id,provider_code,external_event_id);
CREATE INDEX payment_receipt_due ON shared_payment_provider_events(status,next_attempt_at);
CREATE INDEX payment_receipt_payment ON shared_payment_provider_events(workspace_id,payment_id);
CREATE FUNCTION shared_payment_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PAYMENT_RECEIPT_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF NEW.payment_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM commercial_pack_records p WHERE p.id=NEW.payment_id AND p.workspace_id=NEW.workspace_id AND p.collection='payments' AND p.data->>'flow'='COMMERCE')
 THEN RAISE EXCEPTION 'PAYMENT_NOT_FOUND' USING ERRCODE='23503'; END IF;
 IF TG_OP='UPDATE' AND (ROW(NEW.id,NEW.workspace_id,NEW.connection_id,NEW.provider_code,NEW.external_event_id,NEW.payload_hash,NEW.normalized,NEW.signature_verified,NEW.received_at)
   IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.connection_id,OLD.provider_code,OLD.external_event_id,OLD.payload_hash,OLD.normalized,OLD.signature_verified,OLD.received_at)
   OR OLD.payment_id IS NOT NULL AND NEW.payment_id IS DISTINCT FROM OLD.payment_id OR NEW.attempts<OLD.attempts
   OR OLD.status<>'QUEUED' AND ROW(NEW.status,NEW.outcome,NEW.processed_at) IS DISTINCT FROM ROW(OLD.status,OLD.outcome,OLD.processed_at))
 THEN RAISE EXCEPTION 'PAYMENT_RECEIPT_IMMUTABLE' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER shared_payment_receipt_owner BEFORE INSERT OR UPDATE OR DELETE ON shared_payment_provider_events FOR EACH ROW EXECUTE FUNCTION shared_payment_receipt_guard();
CREATE FUNCTION shared_payment_baseline_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.baseline_captured_amount IS DISTINCT FROM OLD.baseline_captured_amount THEN RAISE EXCEPTION 'PAYMENT_COMMAND_IMMUTABLE' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER shared_payment_baseline BEFORE UPDATE ON shared_payment_commands FOR EACH ROW EXECUTE FUNCTION shared_payment_baseline_guard();

CREATE FUNCTION managed_payment_allocation_total() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ws uuid; pid uuid; p jsonb; allocated numeric; refunded numeric; invoiced numeric;
BEGIN
 IF TG_TABLE_NAME='commerce_order_payment_bindings' THEN
  ws:=NEW.workspace_id;pid:=NEW.payment_id;
 ELSE
  ws:=NEW.workspace_id;
  IF NEW.collection='payments' THEN pid:=NEW.id;
  ELSIF NEW.collection IN ('refunds','paymentAllocations') THEN pid:=NULLIF(NEW.data->>'paymentId','')::uuid;
  ELSE RETURN NULL; END IF;
 END IF;
 SELECT data INTO p FROM commercial_pack_records WHERE workspace_id=ws AND id=pid AND collection='payments' AND data->>'flow'='COMMERCE';
 IF p IS NULL THEN RETURN NULL; END IF;
 SELECT COALESCE(sum(amount),0) INTO allocated FROM commerce_order_payment_bindings WHERE workspace_id=ws AND payment_id=pid;
 SELECT COALESCE(sum((data->>'amount')::numeric),0) INTO refunded FROM commercial_pack_records WHERE workspace_id=ws AND collection='refunds' AND data->>'paymentId'=pid::text AND data->>'status'='SUCCEEDED';
 SELECT COALESCE(sum((data->>'amount')::numeric),0) INTO invoiced FROM commercial_pack_records WHERE workspace_id=ws AND collection='paymentAllocations' AND data->>'paymentId'=pid::text AND data->>'status'='ACTIVE';
 IF allocated+refunded+invoiced>(p->>'capturedAmount')::numeric OR refunded<0 OR invoiced<0 THEN RAISE EXCEPTION 'PAYMENT_ALLOCATIONS_EXCEED_CAPTURE' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER managed_payment_allocation_record AFTER INSERT OR UPDATE ON commercial_pack_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION managed_payment_allocation_total();
CREATE CONSTRAINT TRIGGER managed_payment_allocation_order AFTER INSERT OR UPDATE ON commerce_order_payment_bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION managed_payment_allocation_total();
