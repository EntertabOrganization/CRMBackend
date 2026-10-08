-- CreateEnum
CREATE TYPE "CalendarType" AS ENUM ('PERSONAL', 'COMPANY', 'DEPARTMENT', 'PROJECT');

-- CreateEnum
CREATE TYPE "CalendarPermissionLevel" AS ENUM ('VIEW', 'CREATE', 'EDIT_OWN', 'EDIT_ALL', 'MANAGE');

-- CreateEnum
CREATE TYPE "CalendarPermissionSubject" AS ENUM ('USER', 'ROLE', 'DEPARTMENT', 'DEPARTMENT_TREE', 'PROJECT_ROLE', 'WORKSPACE');

-- CreateTable
CREATE TABLE "calendars" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "type" "CalendarType" NOT NULL,
    "owner_user_id" UUID,
    "department_id" UUID,
    "project_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "timezone" TEXT NOT NULL,
    "color_preference" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_read_only" BOOLEAN NOT NULL DEFAULT false,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "calendars_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_permissions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "calendar_id" UUID NOT NULL,
    "subject_type" "CalendarPermissionSubject" NOT NULL,
    "subject_id" TEXT,
    "level" "CalendarPermissionLevel" NOT NULL,

    CONSTRAINT "calendar_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_calendar_preferences" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "calendar_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "color_preference" TEXT,
    "is_visible" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "user_calendar_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "calendars_project_id_key" ON "calendars"("project_id");

-- CreateIndex
CREATE INDEX "calendars_workspace_id_type_is_deleted_idx" ON "calendars"("workspace_id", "type", "is_deleted");

-- CreateIndex
CREATE INDEX "calendars_workspace_id_owner_user_id_idx" ON "calendars"("workspace_id", "owner_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "calendars_workspace_id_id_key" ON "calendars"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "calendar_permissions_workspace_id_subject_type_subject_id_idx" ON "calendar_permissions"("workspace_id", "subject_type", "subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_permissions_calendar_id_subject_type_subject_id_key" ON "calendar_permissions"("calendar_id", "subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "user_calendar_preferences_workspace_id_user_id_idx" ON "user_calendar_preferences"("workspace_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_calendar_preferences_calendar_id_user_id_key" ON "user_calendar_preferences"("calendar_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "departments_workspace_id_id_key" ON "departments"("workspace_id", "id");

-- AddForeignKey
ALTER TABLE "calendars" ADD CONSTRAINT "calendars_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendars" ADD CONSTRAINT "calendars_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendars" ADD CONSTRAINT "calendars_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendars" ADD CONSTRAINT "calendars_workspace_id_department_id_fkey" FOREIGN KEY ("workspace_id", "department_id") REFERENCES "departments"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendars" ADD CONSTRAINT "calendars_workspace_id_project_id_fkey" FOREIGN KEY ("workspace_id", "project_id") REFERENCES "projects"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_permissions" ADD CONSTRAINT "calendar_permissions_workspace_id_calendar_id_fkey" FOREIGN KEY ("workspace_id", "calendar_id") REFERENCES "calendars"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_calendar_preferences" ADD CONSTRAINT "user_calendar_preferences_workspace_id_calendar_id_fkey" FOREIGN KEY ("workspace_id", "calendar_id") REFERENCES "calendars"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_calendar_preferences" ADD CONSTRAINT "user_calendar_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
-- Optimistic concurrency and tenant/type invariants beyond Prisma's relational model.
CREATE TRIGGER "calendars_version_guard" BEFORE UPDATE ON "calendars"
  FOR EACH ROW EXECUTE FUNCTION collab_enforce_version_increase();
CREATE TRIGGER "user_calendar_preferences_version_guard" BEFORE UPDATE ON "user_calendar_preferences"
  FOR EACH ROW EXECUTE FUNCTION collab_enforce_version_increase();

ALTER TABLE "calendars" ADD CONSTRAINT "calendars_container_type_chk" CHECK (
  (type IN ('PERSONAL', 'COMPANY') AND owner_user_id IS NOT NULL AND department_id IS NULL AND project_id IS NULL)
  OR (type = 'DEPARTMENT' AND department_id IS NOT NULL AND owner_user_id IS NULL AND project_id IS NULL)
  OR (type = 'PROJECT' AND department_id IS NULL AND
    ((project_id IS NOT NULL AND owner_user_id IS NULL) OR (project_id IS NULL AND is_read_only)))
);
ALTER TABLE "calendars" ADD CONSTRAINT "calendars_version_positive_chk" CHECK (version > 0);
ALTER TABLE "user_calendar_preferences" ADD CONSTRAINT "calendar_preferences_version_positive_chk" CHECK (version > 0);

-- A WORKSPACE subject has no ID; ordinary unique indexes treat NULLs as distinct.
DROP INDEX "calendar_permissions_calendar_id_subject_type_subject_id_key";
CREATE UNIQUE INDEX "calendar_permissions_calendar_id_subject_type_subject_id_key"
  ON "calendar_permissions" ("calendar_id", "subject_type", "subject_id") NULLS NOT DISTINCT;

CREATE FUNCTION calendar_user_tenant_guard() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'calendars' THEN
    IF NOT EXISTS (SELECT 1 FROM workspace_memberships WHERE workspace_id = NEW.workspace_id AND user_id = NEW.created_by_user_id)
      OR (NEW.owner_user_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM workspace_memberships WHERE workspace_id = NEW.workspace_id AND user_id = NEW.owner_user_id
      )) THEN
      RAISE EXCEPTION 'CALENDAR_USER_TENANT_INVALID' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM workspace_memberships WHERE workspace_id = NEW.workspace_id AND user_id = NEW.user_id) THEN
      RAISE EXCEPTION 'CALENDAR_USER_TENANT_INVALID' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "calendar_user_tenant_guard" BEFORE INSERT OR UPDATE ON "calendars"
  FOR EACH ROW EXECUTE FUNCTION calendar_user_tenant_guard();
CREATE TRIGGER "calendar_preference_user_tenant_guard" BEFORE INSERT OR UPDATE ON "user_calendar_preferences"
  FOR EACH ROW EXECUTE FUNCTION calendar_user_tenant_guard();

CREATE FUNCTION calendar_permission_tenant_guard() RETURNS trigger AS $$
DECLARE valid_subject boolean := false;
BEGIN
  CASE NEW.subject_type
    WHEN 'WORKSPACE' THEN valid_subject := NEW.subject_id IS NULL;
    WHEN 'PROJECT_ROLE' THEN valid_subject := NEW.subject_id IN ('OWNER', 'MODERATOR', 'MEMBER')
      AND EXISTS (SELECT 1 FROM calendars WHERE id = NEW.calendar_id AND workspace_id = NEW.workspace_id AND project_id IS NOT NULL);
    WHEN 'USER' THEN valid_subject := EXISTS (
      SELECT 1 FROM workspace_memberships WHERE workspace_id = NEW.workspace_id AND user_id::text = NEW.subject_id);
    WHEN 'ROLE' THEN valid_subject := EXISTS (
      SELECT 1 FROM roles WHERE workspace_id = NEW.workspace_id AND id::text = NEW.subject_id);
    WHEN 'DEPARTMENT', 'DEPARTMENT_TREE' THEN valid_subject := EXISTS (
      SELECT 1 FROM departments WHERE workspace_id = NEW.workspace_id AND id::text = NEW.subject_id);
  END CASE;
  IF valid_subject IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'CALENDAR_PERMISSION_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "calendar_permission_tenant_guard" BEFORE INSERT OR UPDATE ON "calendar_permissions"
  FOR EACH ROW EXECUTE FUNCTION calendar_permission_tenant_guard();
