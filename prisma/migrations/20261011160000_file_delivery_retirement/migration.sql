BEGIN;
ALTER TABLE file_delivery_grants ADD COLUMN resource_share_version INTEGER NOT NULL DEFAULT 1 CHECK(resource_share_version > 0);
ALTER TABLE file_delivery_grants DISABLE TRIGGER file_delivery_grant_guard;
-- Pre-existing unsigned-revision grants have no reliable issuance share version. Retire them rather than revive a stale URL.
UPDATE file_delivery_grants SET consumed_at = COALESCE(consumed_at, created_at);
ALTER TABLE file_delivery_grants ENABLE TRIGGER file_delivery_grant_guard;
ALTER TABLE file_delivery_grants ALTER COLUMN resource_share_version DROP DEFAULT;
CREATE FUNCTION file_delivery_retirement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'FILE_DELIVERY_UNAVAILABLE' USING ERRCODE = '23514'; END $$;
CREATE TRIGGER file_delivery_retirement_guard BEFORE DELETE ON file_delivery_grants FOR EACH ROW EXECUTE FUNCTION file_delivery_retirement_guard();
COMMIT;
