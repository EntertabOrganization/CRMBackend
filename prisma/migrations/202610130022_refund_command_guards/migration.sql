CREATE FUNCTION shared_refund_command_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b commerce_refund_bindings%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'REFUND_COMMAND_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND (ROW(NEW.id,NEW.workspace_id,NEW.refund_id,NEW.payment_id,NEW.actor_user_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.refund_id,OLD.payment_id,OLD.actor_user_id,OLD.created_at) OR NEW.attempts<OLD.attempts OR OLD.status='SUCCEEDED' AND ROW(NEW.status,NEW.uncertain) IS DISTINCT FROM ROW(OLD.status,OLD.uncertain)) THEN RAISE EXCEPTION 'REFUND_COMMAND_IMMUTABLE' USING ERRCODE='23514'; END IF;
 SELECT * INTO b FROM commerce_refund_bindings WHERE workspace_id=NEW.workspace_id AND refund_id=NEW.refund_id;
 IF b.payment_id IS DISTINCT FROM NEW.payment_id THEN RAISE EXCEPTION 'REFUND_COMMAND_BINDING_INVALID' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER shared_refund_command_owner BEFORE INSERT OR UPDATE OR DELETE ON shared_refund_commands FOR EACH ROW EXECUTE FUNCTION shared_refund_command_guard();
CREATE FUNCTION managed_refund_lifecycle_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.collection<>'refunds' OR OLD.data->>'flow' IS DISTINCT FROM 'COMMERCE' THEN RETURN NEW; END IF;
 IF (NEW.data->>'version')::bigint<(OLD.data->>'version')::bigint OR (NEW.data->>'status' IS DISTINCT FROM OLD.data->>'status' AND ((NEW.data->>'version')::bigint<=(OLD.data->>'version')::bigint OR NOT ((OLD.data->>'status'='PENDING_APPROVAL' AND NEW.data->>'status' IN ('APPROVED','CANCELLED')) OR (OLD.data->>'status'='APPROVED' AND NEW.data->>'status'='PROCESSING') OR (OLD.data->>'status'='PROCESSING' AND NEW.data->>'status' IN ('SUCCEEDED','FAILED','CANCELLED'))))) THEN RAISE EXCEPTION 'REFUND_INVALID_TRANSITION' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER managed_refund_lifecycle BEFORE UPDATE ON commercial_pack_records FOR EACH ROW EXECUTE FUNCTION managed_refund_lifecycle_guard();
CREATE FUNCTION shared_refund_completion_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r JSONB;c shared_refund_commands%ROWTYPE;
BEGIN
 SELECT * INTO c FROM shared_refund_commands WHERE id=NEW.id;
 IF c.status<>'SUCCEEDED' THEN RETURN NULL; END IF;
 SELECT data INTO r FROM commercial_pack_records WHERE workspace_id=c.workspace_id AND id=c.refund_id AND collection='refunds';
 IF r->>'status' IS DISTINCT FROM 'SUCCEEDED' OR c.uncertain OR r->>'providerRefundId' IS NULL THEN RAISE EXCEPTION 'REFUND_CONFIRMATION_REQUIRED' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER shared_refund_completion AFTER INSERT OR UPDATE ON shared_refund_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION shared_refund_completion_guard();
