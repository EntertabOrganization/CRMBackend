# Projects & Workgroups Specification

## Goal / Scope

Implement the common collaboration container for deadline-driven Projects and ongoing Workgroups, including lifecycle, visibility and enabled tools.

## Ownership / Boundary

`ProjectsController` owns Project/Workgroup CRUD/lifecycle and high-level configuration. Linked Calendar/Drive/Chat are provisioned through owning module services.

## Entities / Fields / Enums

```text
projects:
 id, workspaceId, name, code, description,
 projectType PROJECT|WORKGROUP,
 status PLANNED|ACTIVE|ON_HOLD|COMPLETED|CANCELLED|ARCHIVED,
 ownerUserId, startDate nullable, endDate nullable,
 visibility PRIVATE|WORKSPACE_VISIBLE|OPEN|INVITE_ONLY,
 version, isDeleted

project_tools:
 id, workspaceId, projectId,
 toolType TASKS|KANBAN|CALENDAR|DRIVE|FEED|CHAT|REPORTS|KNOWLEDGE,
 isEnabled, configurationJson
```
One owner is required while Project is active.

## API Endpoints

```text
POST   /api/v1/projects
GET    /api/v1/projects
GET    /api/v1/projects/:id
PUT    /api/v1/projects/:id
PATCH  /api/v1/projects/:id
DELETE /api/v1/projects/:id
PATCH  /api/v1/projects/:id/restore
DELETE /api/v1/projects/:id/hard
POST   /api/v1/projects/:id/archive
POST   /api/v1/projects/:id/unarchive
GET    /api/v1/projects/:id/tools
PUT    /api/v1/projects/:id/tools
POST   /api/v1/projects/:id/tools/:tool/enable
POST   /api/v1/projects/:id/tools/:tool/disable
GET    /api/v1/projects/:id/linked-resources
```

## Business Rules / Validation

- Project and Workgroup share storage/model but retain different type semantics.
- Owner must be an active same-Workspace internal user.
- External guests cannot be ordinary Project members.
- Visibility controls discovery/entry but does not automatically grant mutation rights.
- Enable Chat/Calendar/Drive lazily provisions one canonical linked resource through owning service.
- Provisioning must tolerate retries and return existing canonical resource.
- Archive makes Project operationally read-only and linked project-owned resources read-only by policy; unarchive restores mutation capability where still authorized.
- Hard delete never blindly cascades into File versions, Chat history, Calendar history or central Audit.

## Permissions

- `PROJECT.CREATE`
- `PROJECT.READ`
- `PROJECT.UPDATE`
- `PROJECT.DELETE`
- `PROJECT.HARD_DELETE`
- `PROJECT.ARCHIVE`
- `PROJECT.TOOL_MANAGE`

## Tenant / Ownership Rules

- All business rows and queries are scoped to the resolved active Workspace.
- Cross-Workspace IDs must not be linkable or inferable through this API.
- Resource-level authorization is re-evaluated server-side on every operation; possession of an ID is never authorization.

## Stable Error Cases

- `PROJECT_NOT_FOUND`
- `PROJECT_OWNER_INVALID`
- `PROJECT_ARCHIVED`
- `PROJECT_TOOL_DISABLED`
- `PROJECT_LINKED_RESOURCE_PROVISION_FAILED`
- `RESOURCE_VERSION_CONFLICT`
- `PERMISSION_DENIED`

## Domain / Outbox Events

- `PROJECT_CREATED`
- `PROJECT_UPDATED`
- `PROJECT_ARCHIVED`
- `PROJECT_UNARCHIVED`
- `PROJECT_DELETED`
- `PROJECT_TOOL_ENABLED`
- `PROJECT_TOOL_DISABLED`

## Audit Events / Evidence

- `PROJECT.CREATED`
- `PROJECT.OWNER_CHANGED`
- `PROJECT.ARCHIVED`
- `PROJECT.HARD_DELETED`
- `PROJECT.TOOL_CHANGED`

## Dependencies / Integrations

- Project members
- Tasks
- Communication
- Calendar
- Files

## Testing Requirements

- Visibility vs membership.
- Idempotent linked resource provisioning.
- Archive read-only behavior.
- Hard delete preserving external histories.

## Acceptance Criteria

- A Project can be created without eagerly creating all linked resources.
- Enabling a tool twice never creates two canonical Project resources.
