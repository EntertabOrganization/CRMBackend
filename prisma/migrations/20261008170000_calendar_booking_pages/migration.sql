CREATE TABLE calendar_booking_pages (
  id UUID PRIMARY KEY, workspace_id UUID NOT NULL, owner_user_id UUID NOT NULL, calendar_id UUID NOT NULL,
  created_by_user_id UUID NOT NULL, title TEXT NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 500),
  slug TEXT NOT NULL UNIQUE CHECK(length(slug) BETWEEN 3 AND 80 AND slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT', 'PUBLISHED', 'UNPUBLISHED')),
  booking_mode TEXT NOT NULL DEFAULT 'AUTO_CONFIRM' CHECK(booking_mode IN ('AUTO_CONFIRM', 'REQUIRE_APPROVAL')),
  duration_minutes INTEGER NOT NULL CHECK(duration_minutes BETWEEN 1 AND 1440),
  timezone_policy TEXT NOT NULL DEFAULT 'HOST' CHECK(timezone_policy IN ('HOST', 'INVITEE')), timezone TEXT NOT NULL,
  require_name BOOLEAN NOT NULL DEFAULT true CHECK(require_name), require_email BOOLEAN NOT NULL DEFAULT true CHECK(require_email),
  require_phone BOOLEAN NOT NULL DEFAULT false,
  min_notice_minutes INTEGER NOT NULL DEFAULT 0 CHECK(min_notice_minutes BETWEEN 0 AND 525600),
  max_advance_days INTEGER NOT NULL DEFAULT 90 CHECK(max_advance_days BETWEEN 1 AND 365),
  buffer_before_minutes INTEGER NOT NULL DEFAULT 0 CHECK(buffer_before_minutes BETWEEN 0 AND 1440),
  buffer_after_minutes INTEGER NOT NULL DEFAULT 0 CHECK(buffer_after_minutes BETWEEN 0 AND 1440),
  is_deleted BOOLEAN NOT NULL DEFAULT false, version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at TIMESTAMPTZ(6) NOT NULL, updated_at TIMESTAMPTZ(6) NOT NULL,
  UNIQUE(workspace_id, id),
  FOREIGN KEY(workspace_id, owner_user_id) REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE NO ACTION,
  FOREIGN KEY(workspace_id, created_by_user_id) REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE NO ACTION,
  FOREIGN KEY(workspace_id, calendar_id) REFERENCES calendars(workspace_id, id) ON DELETE NO ACTION,
  CHECK(NOT is_deleted OR status = 'UNPUBLISHED')
);
CREATE INDEX calendar_booking_pages_workspace_owner ON calendar_booking_pages(workspace_id, owner_user_id, status);
CREATE TABLE calendar_availability_rules (
  id UUID PRIMARY KEY, workspace_id UUID NOT NULL, page_id UUID NOT NULL UNIQUE,
  timezone TEXT NOT NULL, weekly JSONB NOT NULL, holidays JSONB NOT NULL, overrides JSONB NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0), created_at TIMESTAMPTZ(6) NOT NULL, updated_at TIMESTAMPTZ(6) NOT NULL,
  FOREIGN KEY(workspace_id, page_id) REFERENCES calendar_booking_pages(workspace_id, id) ON DELETE NO ACTION
);
CREATE FUNCTION calendar_booking_page_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.workspace_id <> NEW.workspace_id OR OLD.created_by_user_id <> NEW.created_by_user_id THEN
      RAISE EXCEPTION 'BOOKING_PAGE_NOT_FOUND' USING ERRCODE = '23514';
    END IF;
    IF NEW.version <> OLD.version + 1 THEN RAISE EXCEPTION 'RESOURCE_VERSION_CONFLICT' USING ERRCODE = '23514'; END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE lower(name) = lower(NEW.timezone)) THEN
    RAISE EXCEPTION 'BOOKING_PAGE_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER calendar_booking_page_guard BEFORE INSERT OR UPDATE ON calendar_booking_pages FOR EACH ROW EXECUTE FUNCTION calendar_booking_page_guard();
CREATE FUNCTION calendar_booking_rules_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.page_id <> NEW.page_id THEN RAISE EXCEPTION 'BOOKING_PAGE_NOT_FOUND' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER calendar_booking_rules_identity_guard BEFORE UPDATE ON calendar_availability_rules FOR EACH ROW EXECUTE FUNCTION calendar_booking_rules_identity_guard();
CREATE TRIGGER calendar_booking_rules_schedule_guard BEFORE INSERT OR UPDATE ON calendar_availability_rules FOR EACH ROW EXECUTE FUNCTION calendar_working_schedule_guard();
