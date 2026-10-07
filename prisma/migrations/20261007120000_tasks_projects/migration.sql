-- CreateEnum
CREATE TYPE "ProjectType" AS ENUM ('PROJECT', 'WORKGROUP');

-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('PLANNED', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ProjectVisibility" AS ENUM ('PRIVATE', 'WORKSPACE_VISIBLE', 'OPEN', 'INVITE_ONLY');

-- CreateEnum
CREATE TYPE "ProjectRole" AS ENUM ('OWNER', 'MODERATOR', 'MEMBER');

-- CreateEnum
CREATE TYPE "ProjectMemberStatus" AS ENUM ('ACTIVE', 'INVITED', 'REMOVED');

-- CreateEnum
CREATE TYPE "ProjectToolType" AS ENUM ('TASKS', 'KANBAN', 'CALENDAR', 'DRIVE', 'FEED', 'CHAT', 'REPORTS', 'KNOWLEDGE');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'REVIEW', 'COMPLETED', 'DEFERRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TaskPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "TaskMemberRole" AS ENUM ('PARTICIPANT', 'OBSERVER');

-- CreateEnum
CREATE TYPE "SubtaskCompletionPolicy" AS ENUM ('IGNORE', 'WARN', 'REQUIRE_ALL');

-- CreateEnum
CREATE TYPE "TaskReviewDecision" AS ENUM ('PENDING', 'APPROVED', 'RETURNED');

-- CreateEnum
CREATE TYPE "TaskResultType" AS ENUM ('TEXT', 'FILE', 'LINK');

-- CreateEnum
CREATE TYPE "TaskDependencyType" AS ENUM ('FINISH_START', 'START_START', 'FINISH_FINISH', 'START_FINISH');

-- CreateEnum
CREATE TYPE "TaskTimeEntrySource" AS ENUM ('MANUAL', 'TIMER');

-- CreateEnum
CREATE TYPE "TaskTimeEntryStatus" AS ENUM ('ACTIVE', 'COMPLETED');

-- CreateEnum
CREATE TYPE "RecurrenceFrequency" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY');

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "description" TEXT,
    "project_type" "ProjectType" NOT NULL,
    "status" "ProjectStatus" NOT NULL,
    "status_before_archive" "ProjectStatus",
    "owner_user_id" UUID NOT NULL,
    "start_date" DATE,
    "end_date" DATE,
    "visibility" "ProjectVisibility" NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by_user_id" UUID,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_members" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "member_role" "ProjectRole" NOT NULL,
    "status" "ProjectMemberStatus" NOT NULL,
    "joined_at" TIMESTAMPTZ(6),
    "left_at" TIMESTAMPTZ(6),
    "invited_by_user_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "project_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_tools" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "tool_type" "ProjectToolType" NOT NULL,
    "is_enabled" BOOLEAN NOT NULL,
    "configuration_json" JSONB NOT NULL DEFAULT '{}',
    "linked_resource_type" TEXT,
    "linked_resource_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "project_tools_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_stages" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "is_default" BOOLEAN NOT NULL,
    "is_terminal_visual_stage" BOOLEAN NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "project_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID,
    "project_stage_id" UUID,
    "parent_task_id" UUID,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "TaskStatus" NOT NULL,
    "priority" "TaskPriority" NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "responsible_user_id" UUID NOT NULL,
    "start_at" TIMESTAMPTZ(6),
    "deadline_at" TIMESTAMPTZ(6),
    "planned_duration_seconds" INTEGER,
    "progress_percent" INTEGER NOT NULL DEFAULT 0,
    "requires_result" BOOLEAN NOT NULL,
    "completion_control" BOOLEAN NOT NULL,
    "subtask_completion_policy" "SubtaskCompletionPolicy" NOT NULL,
    "is_time_tracking_enabled" BOOLEAN NOT NULL,
    "template_id" UUID,
    "recurrence_instance_id" UUID,
    "overdue_notified_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by_user_id" UUID,
    "completed_at" TIMESTAMPTZ(6),
    "completed_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_stage_history" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "old_stage_id" UUID,
    "new_stage_id" UUID NOT NULL,
    "moved_by_user_id" UUID NOT NULL,
    "moved_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "project_stage_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_members" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "TaskMemberRole" NOT NULL,
    "added_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "task_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_completion_reviews" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "submitted_by_user_id" UUID NOT NULL,
    "submitted_at" TIMESTAMPTZ(6) NOT NULL,
    "reviewer_user_id" UUID,
    "decision" "TaskReviewDecision" NOT NULL,
    "comment" TEXT,
    "decided_at" TIMESTAMPTZ(6),

    CONSTRAINT "task_completion_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_results" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "result_type" "TaskResultType" NOT NULL,
    "text_value" TEXT,
    "file_id" UUID,
    "url" TEXT,
    "submitted_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "task_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_deadline_history" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "old_deadline_at" TIMESTAMPTZ(6),
    "new_deadline_at" TIMESTAMPTZ(6),
    "changed_by_user_id" UUID NOT NULL,
    "reason" TEXT,
    "changed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "task_deadline_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_history" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "field" TEXT,
    "old_value" JSONB,
    "new_value" JSONB,
    "actor_user_id" UUID,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "task_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_crm_bindings" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "task_crm_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_planner_positions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "planner_column" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "task_planner_positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_checklists" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "task_checklists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_checklist_items" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "checklist_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "parent_item_id" UUID,
    "title" TEXT NOT NULL,
    "assigned_user_id" UUID,
    "is_completed" BOOLEAN NOT NULL,
    "completed_by_user_id" UUID,
    "completed_at" TIMESTAMPTZ(6),
    "sort_order" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "task_checklist_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_dependencies" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "predecessor_task_id" UUID NOT NULL,
    "successor_task_id" UUID NOT NULL,
    "type" "TaskDependencyType" NOT NULL,
    "lag_seconds" INTEGER NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "task_dependencies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_time_entries" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "ended_at" TIMESTAMPTZ(6),
    "duration_seconds" INTEGER NOT NULL,
    "source" "TaskTimeEntrySource" NOT NULL,
    "note" TEXT,
    "status" "TaskTimeEntryStatus" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "task_time_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_templates" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "scope_type" TEXT NOT NULL,
    "scope_id" UUID,
    "name" TEXT NOT NULL,
    "title_template" TEXT NOT NULL,
    "description_template" TEXT,
    "project_id" UUID,
    "default_responsible_user_id" UUID,
    "priority" "TaskPriority" NOT NULL,
    "deadline_offset_seconds" INTEGER,
    "planned_duration_seconds" INTEGER,
    "is_time_tracking_enabled" BOOLEAN NOT NULL,
    "completion_control" BOOLEAN NOT NULL,
    "requires_result" BOOLEAN NOT NULL,
    "subtask_completion_policy" "SubtaskCompletionPolicy" NOT NULL,
    "file_ids" UUID[],
    "is_active" BOOLEAN NOT NULL,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_by_user_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "task_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_template_members" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "TaskMemberRole" NOT NULL,

    CONSTRAINT "task_template_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_template_checklist_items" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "checklist_name" TEXT NOT NULL,
    "parent_item_id" UUID,
    "title" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL,

    CONSTRAINT "task_template_checklist_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_template_subtasks" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "child_template_id" UUID NOT NULL,
    "sort_order" INTEGER NOT NULL,

    CONSTRAINT "task_template_subtasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_recurrence_rules" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "frequency" "RecurrenceFrequency" NOT NULL,
    "interval_value" INTEGER NOT NULL,
    "days_of_week" INTEGER[],
    "day_of_month" INTEGER,
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "max_occurrences" INTEGER,
    "creation_local_time" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "next_run_at" TIMESTAMPTZ(6),
    "occurrence_count" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "last_error_code" TEXT,
    "last_error_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "task_recurrence_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_recurrence_instances" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "recurrence_rule_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "task_id" UUID,
    "scheduled_for" TIMESTAMPTZ(6) NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL,
    "last_error_code" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "task_recurrence_instances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "projects_workspace_id_status_idx" ON "projects"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "projects_workspace_id_owner_user_id_idx" ON "projects"("workspace_id", "owner_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "projects_workspace_id_id_key" ON "projects"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "projects_workspace_id_code_key" ON "projects"("workspace_id", "code");

-- CreateIndex
CREATE INDEX "project_members_workspace_id_user_id_status_idx" ON "project_members"("workspace_id", "user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "project_members_project_id_user_id_key" ON "project_members"("project_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_tools_project_id_tool_type_key" ON "project_tools"("project_id", "tool_type");

-- CreateIndex
CREATE INDEX "project_stages_project_id_sort_order_idx" ON "project_stages"("project_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "project_stages_workspace_id_id_key" ON "project_stages"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "tasks_workspace_id_status_idx" ON "tasks"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "tasks_workspace_id_responsible_user_id_status_idx" ON "tasks"("workspace_id", "responsible_user_id", "status");

-- CreateIndex
CREATE INDEX "tasks_workspace_id_project_id_idx" ON "tasks"("workspace_id", "project_id");

-- CreateIndex
CREATE INDEX "tasks_workspace_id_deadline_at_idx" ON "tasks"("workspace_id", "deadline_at");

-- CreateIndex
CREATE INDEX "tasks_workspace_id_parent_task_id_idx" ON "tasks"("workspace_id", "parent_task_id");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_workspace_id_id_key" ON "tasks"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "project_stage_history_task_id_moved_at_idx" ON "project_stage_history"("task_id", "moved_at");

-- CreateIndex
CREATE INDEX "task_members_workspace_id_user_id_idx" ON "task_members"("workspace_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "task_members_task_id_user_id_role_key" ON "task_members"("task_id", "user_id", "role");

-- CreateIndex
CREATE INDEX "task_completion_reviews_task_id_submitted_at_idx" ON "task_completion_reviews"("task_id", "submitted_at");

-- CreateIndex
CREATE INDEX "task_results_task_id_created_at_idx" ON "task_results"("task_id", "created_at");

-- CreateIndex
CREATE INDEX "task_deadline_history_task_id_changed_at_idx" ON "task_deadline_history"("task_id", "changed_at");

-- CreateIndex
CREATE INDEX "task_history_task_id_occurred_at_idx" ON "task_history"("task_id", "occurred_at");

-- CreateIndex
CREATE INDEX "task_crm_bindings_workspace_id_entity_type_entity_id_idx" ON "task_crm_bindings"("workspace_id", "entity_type", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "task_crm_bindings_task_id_entity_type_entity_id_key" ON "task_crm_bindings"("task_id", "entity_type", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "task_planner_positions_user_id_task_id_key" ON "task_planner_positions"("user_id", "task_id");

-- CreateIndex
CREATE INDEX "task_checklists_task_id_sort_order_idx" ON "task_checklists"("task_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "task_checklists_workspace_id_id_key" ON "task_checklists"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "task_checklist_items_checklist_id_parent_item_id_sort_order_idx" ON "task_checklist_items"("checklist_id", "parent_item_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "task_checklist_items_workspace_id_id_key" ON "task_checklist_items"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "task_dependencies_workspace_id_successor_task_id_idx" ON "task_dependencies"("workspace_id", "successor_task_id");

-- CreateIndex
CREATE UNIQUE INDEX "task_dependencies_predecessor_task_id_successor_task_id_key" ON "task_dependencies"("predecessor_task_id", "successor_task_id");

-- CreateIndex
CREATE INDEX "task_time_entries_task_id_user_id_idx" ON "task_time_entries"("task_id", "user_id");

-- CreateIndex
CREATE INDEX "task_templates_workspace_id_is_deleted_idx" ON "task_templates"("workspace_id", "is_deleted");

-- CreateIndex
CREATE UNIQUE INDEX "task_templates_workspace_id_id_key" ON "task_templates"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "task_template_members_template_id_user_id_role_key" ON "task_template_members"("template_id", "user_id", "role");

-- CreateIndex
CREATE INDEX "task_template_checklist_items_template_id_sort_order_idx" ON "task_template_checklist_items"("template_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "task_template_subtasks_template_id_child_template_id_key" ON "task_template_subtasks"("template_id", "child_template_id");

-- CreateIndex
CREATE INDEX "task_recurrence_rules_is_active_next_run_at_idx" ON "task_recurrence_rules"("is_active", "next_run_at");

-- CreateIndex
CREATE UNIQUE INDEX "task_recurrence_rules_workspace_id_id_key" ON "task_recurrence_rules"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "task_recurrence_rules_template_id_key" ON "task_recurrence_rules"("template_id");

-- CreateIndex
CREATE INDEX "task_recurrence_instances_workspace_id_status_idx" ON "task_recurrence_instances"("workspace_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "task_recurrence_instances_recurrence_rule_id_scheduled_for_key" ON "task_recurrence_instances"("recurrence_rule_id", "scheduled_for");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_workspace_id_project_id_fkey" FOREIGN KEY ("workspace_id", "project_id") REFERENCES "projects"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_tools" ADD CONSTRAINT "project_tools_workspace_id_project_id_fkey" FOREIGN KEY ("workspace_id", "project_id") REFERENCES "projects"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_stages" ADD CONSTRAINT "project_stages_workspace_id_project_id_fkey" FOREIGN KEY ("workspace_id", "project_id") REFERENCES "projects"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_workspace_id_project_id_fkey" FOREIGN KEY ("workspace_id", "project_id") REFERENCES "projects"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_workspace_id_project_stage_id_fkey" FOREIGN KEY ("workspace_id", "project_stage_id") REFERENCES "project_stages"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_workspace_id_parent_task_id_fkey" FOREIGN KEY ("workspace_id", "parent_task_id") REFERENCES "tasks"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_workspace_id_template_id_fkey" FOREIGN KEY ("workspace_id", "template_id") REFERENCES "task_templates"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_stage_history" ADD CONSTRAINT "project_stage_history_workspace_id_task_id_fkey" FOREIGN KEY ("workspace_id", "task_id") REFERENCES "tasks"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_members" ADD CONSTRAINT "task_members_workspace_id_task_id_fkey" FOREIGN KEY ("workspace_id", "task_id") REFERENCES "tasks"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_completion_reviews" ADD CONSTRAINT "task_completion_reviews_workspace_id_task_id_fkey" FOREIGN KEY ("workspace_id", "task_id") REFERENCES "tasks"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_results" ADD CONSTRAINT "task_results_workspace_id_task_id_fkey" FOREIGN KEY ("workspace_id", "task_id") REFERENCES "tasks"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_deadline_history" ADD CONSTRAINT "task_deadline_history_workspace_id_task_id_fkey" FOREIGN KEY ("workspace_id", "task_id") REFERENCES "tasks"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_history" ADD CONSTRAINT "task_history_workspace_id_task_id_fkey" FOREIGN KEY ("workspace_id", "task_id") REFERENCES "tasks"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_crm_bindings" ADD CONSTRAINT "task_crm_bindings_workspace_id_task_id_fkey" FOREIGN KEY ("workspace_id", "task_id") REFERENCES "tasks"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_planner_positions" ADD CONSTRAINT "task_planner_positions_workspace_id_task_id_fkey" FOREIGN KEY ("workspace_id", "task_id") REFERENCES "tasks"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_checklists" ADD CONSTRAINT "task_checklists_workspace_id_task_id_fkey" FOREIGN KEY ("workspace_id", "task_id") REFERENCES "tasks"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_checklist_items" ADD CONSTRAINT "task_checklist_items_workspace_id_checklist_id_fkey" FOREIGN KEY ("workspace_id", "checklist_id") REFERENCES "task_checklists"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_checklist_items" ADD CONSTRAINT "task_checklist_items_workspace_id_task_id_fkey" FOREIGN KEY ("workspace_id", "task_id") REFERENCES "tasks"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_checklist_items" ADD CONSTRAINT "task_checklist_items_workspace_id_parent_item_id_fkey" FOREIGN KEY ("workspace_id", "parent_item_id") REFERENCES "task_checklist_items"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_workspace_id_predecessor_task_id_fkey" FOREIGN KEY ("workspace_id", "predecessor_task_id") REFERENCES "tasks"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_workspace_id_successor_task_id_fkey" FOREIGN KEY ("workspace_id", "successor_task_id") REFERENCES "tasks"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_time_entries" ADD CONSTRAINT "task_time_entries_workspace_id_task_id_fkey" FOREIGN KEY ("workspace_id", "task_id") REFERENCES "tasks"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_templates" ADD CONSTRAINT "task_templates_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_templates" ADD CONSTRAINT "task_templates_workspace_id_project_id_fkey" FOREIGN KEY ("workspace_id", "project_id") REFERENCES "projects"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_template_members" ADD CONSTRAINT "task_template_members_workspace_id_template_id_fkey" FOREIGN KEY ("workspace_id", "template_id") REFERENCES "task_templates"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_template_checklist_items" ADD CONSTRAINT "task_template_checklist_items_workspace_id_template_id_fkey" FOREIGN KEY ("workspace_id", "template_id") REFERENCES "task_templates"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_template_subtasks" ADD CONSTRAINT "task_template_subtasks_workspace_id_template_id_fkey" FOREIGN KEY ("workspace_id", "template_id") REFERENCES "task_templates"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_template_subtasks" ADD CONSTRAINT "task_template_subtasks_workspace_id_child_template_id_fkey" FOREIGN KEY ("workspace_id", "child_template_id") REFERENCES "task_templates"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_recurrence_rules" ADD CONSTRAINT "task_recurrence_rules_workspace_id_template_id_fkey" FOREIGN KEY ("workspace_id", "template_id") REFERENCES "task_templates"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_recurrence_instances" ADD CONSTRAINT "task_recurrence_instances_workspace_id_recurrence_rule_id_fkey" FOREIGN KEY ("workspace_id", "recurrence_rule_id") REFERENCES "task_recurrence_rules"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_recurrence_instances" ADD CONSTRAINT "task_recurrence_instances_workspace_id_task_id_fkey" FOREIGN KEY ("workspace_id", "task_id") REFERENCES "tasks"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------------------------------------------------
-- Invariants Prisma cannot express. They are the last line of defence behind the service-level checks and make the
-- rules hold even when several application instances write concurrently.
-- ---------------------------------------------------------------------------------------------------------------------

-- Optimistic concurrency backstop: every write of a versioned aggregate must move its version forward. A writer that
-- read version N and saves after another writer already stored N+1 fails instead of silently overwriting newer data.
CREATE OR REPLACE FUNCTION collab_enforce_version_increase() RETURNS trigger AS $$
BEGIN
  IF NEW.version <= OLD.version THEN
    RAISE EXCEPTION 'RESOURCE_VERSION_CONFLICT: % % was modified concurrently', TG_TABLE_NAME, OLD.id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "projects_version_guard" BEFORE UPDATE ON "projects" FOR EACH ROW EXECUTE FUNCTION collab_enforce_version_increase();
CREATE TRIGGER "project_members_version_guard" BEFORE UPDATE ON "project_members" FOR EACH ROW EXECUTE FUNCTION collab_enforce_version_increase();
CREATE TRIGGER "project_tools_version_guard" BEFORE UPDATE ON "project_tools" FOR EACH ROW EXECUTE FUNCTION collab_enforce_version_increase();
CREATE TRIGGER "project_stages_version_guard" BEFORE UPDATE ON "project_stages" FOR EACH ROW EXECUTE FUNCTION collab_enforce_version_increase();
CREATE TRIGGER "tasks_version_guard" BEFORE UPDATE ON "tasks" FOR EACH ROW EXECUTE FUNCTION collab_enforce_version_increase();
CREATE TRIGGER "task_checklists_version_guard" BEFORE UPDATE ON "task_checklists" FOR EACH ROW EXECUTE FUNCTION collab_enforce_version_increase();
CREATE TRIGGER "task_checklist_items_version_guard" BEFORE UPDATE ON "task_checklist_items" FOR EACH ROW EXECUTE FUNCTION collab_enforce_version_increase();
CREATE TRIGGER "task_time_entries_version_guard" BEFORE UPDATE ON "task_time_entries" FOR EACH ROW EXECUTE FUNCTION collab_enforce_version_increase();
CREATE TRIGGER "task_templates_version_guard" BEFORE UPDATE ON "task_templates" FOR EACH ROW EXECUTE FUNCTION collab_enforce_version_increase();
CREATE TRIGGER "task_recurrence_rules_version_guard" BEFORE UPDATE ON "task_recurrence_rules" FOR EACH ROW EXECUTE FUNCTION collab_enforce_version_increase();

-- Dependency graph must stay acyclic under concurrent writes: edge writes are serialized per Workspace and the
-- reachability check runs against the committed graph after the lock is held.
CREATE OR REPLACE FUNCTION task_dependencies_prevent_cycle() RETURNS trigger AS $$
DECLARE
  cycle_found boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('task_dependencies:' || NEW.workspace_id::text));
  IF NEW.predecessor_task_id = NEW.successor_task_id THEN
    RAISE EXCEPTION 'TASK_DEPENDENCY_SELF' USING ERRCODE = 'P0001';
  END IF;
  WITH RECURSIVE reach(task_id) AS (
    SELECT d.successor_task_id FROM task_dependencies d
      WHERE d.predecessor_task_id = NEW.successor_task_id AND d.id <> NEW.id
    UNION
    SELECT d.successor_task_id FROM task_dependencies d
      JOIN reach r ON d.predecessor_task_id = r.task_id
      WHERE d.id <> NEW.id
  )
  SELECT EXISTS (SELECT 1 FROM reach WHERE task_id = NEW.predecessor_task_id) INTO cycle_found;
  IF cycle_found THEN
    RAISE EXCEPTION 'TASK_DEPENDENCY_CYCLE' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "task_dependencies_cycle_guard" BEFORE INSERT OR UPDATE ON "task_dependencies" FOR EACH ROW EXECUTE FUNCTION task_dependencies_prevent_cycle();

ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_not_self_chk" CHECK ("predecessor_task_id" <> "successor_task_id");
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_lag_chk" CHECK ("lag_seconds" >= 0);
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_progress_chk" CHECK ("progress_percent" BETWEEN 0 AND 100);
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_planned_duration_chk" CHECK ("planned_duration_seconds" IS NULL OR "planned_duration_seconds" >= 0);
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_not_own_parent_chk" CHECK ("parent_task_id" IS NULL OR "parent_task_id" <> "id");
ALTER TABLE "task_time_entries" ADD CONSTRAINT "task_time_entries_duration_chk" CHECK ("duration_seconds" >= 0);
ALTER TABLE "task_time_entries" ADD CONSTRAINT "task_time_entries_range_chk" CHECK ("ended_at" IS NULL OR "ended_at" > "started_at");
ALTER TABLE "task_checklist_items" ADD CONSTRAINT "task_checklist_items_not_own_parent_chk" CHECK ("parent_item_id" IS NULL OR "parent_item_id" <> "id");
ALTER TABLE "task_recurrence_rules" ADD CONSTRAINT "task_recurrence_rules_interval_chk" CHECK ("interval_value" >= 1);

-- Partial uniqueness rules are deferrable exclusion constraints: one request may legitimately swap the owner, the
-- default stage or a running timer between rows, and the rule only has to hold when the transaction commits.
-- At most one running timer per user per Task.
ALTER TABLE "task_time_entries" ADD CONSTRAINT "task_time_entries_one_active_timer_excl"
  EXCLUDE USING btree ("task_id" WITH =, "user_id" WITH =) WHERE ("status" = 'ACTIVE') DEFERRABLE INITIALLY DEFERRED;
-- Exactly one active owner membership per Project.
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_single_owner_excl"
  EXCLUDE USING btree ("project_id" WITH =) WHERE ("member_role" = 'OWNER' AND "status" = 'ACTIVE') DEFERRABLE INITIALLY DEFERRED;
-- Stage codes and the default stage are unique among live stages of a Project.
ALTER TABLE "project_stages" ADD CONSTRAINT "project_stages_code_excl"
  EXCLUDE USING btree ("project_id" WITH =, "code" WITH =) WHERE ("is_deleted" = false) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "project_stages" ADD CONSTRAINT "project_stages_default_excl"
  EXCLUDE USING btree ("project_id" WITH =) WHERE ("is_default" = true AND "is_deleted" = false) DEFERRABLE INITIALLY DEFERRED;