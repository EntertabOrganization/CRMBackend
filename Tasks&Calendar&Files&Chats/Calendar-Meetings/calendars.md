# Calendars Specification

## Goal / Scope

Implement Personal, Company, Department and Project Calendar containers, preferences and access permissions.

## Ownership / Boundary

`CalendarsController` owns Calendar CRUD and permission assignments. Events remain EventService-owned.

## Entities / Fields / Enums

```text
calendars:
 id, workspaceId, type PERSONAL|COMPANY|DEPARTMENT|PROJECT,
 ownerUserId nullable, departmentId nullable, projectId nullable,
 name, description nullable, timezone, colorPreference nullable,
 isActive, version

calendar_permissions:
 id, workspaceId, calendarId,
 subjectType USER|ROLE|DEPARTMENT|DEPARTMENT_TREE|PROJECT_ROLE|WORKSPACE,
 subjectId nullable,
 level VIEW|CREATE|EDIT_OWN|EDIT_ALL|MANAGE
```
Department/project calendars are linked to same-Workspace source containers.

## API Endpoints

```text
POST   /api/v1/calendars
GET    /api/v1/calendars
GET    /api/v1/calendars/:id
PUT    /api/v1/calendars/:id
PATCH  /api/v1/calendars/:id
DELETE /api/v1/calendars/:id
GET    /api/v1/calendars/:id/permissions
PUT    /api/v1/calendars/:id/permissions
GET    /api/v1/calendars/:id/preferences
PATCH  /api/v1/calendars/:id/preferences
```

## Business Rules / Validation

- Personal Calendar owner is one internal user.
- Department membership grants default Department Calendar view/create according to approved policy; department manager can manage subject to platform permission.
- Project Calendar access derives from Project membership/role plus explicit Calendar permission where stricter.
- Company Calendar broad visibility does not mean broad edit permission.
- Calendar timezone must be valid IANA identifier.

## Permissions

- `CALENDAR.CREATE`
- `CALENDAR.READ`
- `CALENDAR.UPDATE`
- `CALENDAR.DELETE`
- `CALENDAR.PERMISSION_MANAGE`

## Tenant / Ownership Rules

- All business rows and queries are scoped to the resolved active Workspace.
- Cross-Workspace IDs must not be linkable or inferable through this API.
- Resource-level authorization is re-evaluated server-side on every operation; possession of an ID is never authorization.

## Stable Error Cases

- `CALENDAR_NOT_FOUND`
- `CALENDAR_INVALID_OWNER`
- `CALENDAR_INVALID_TIMEZONE`
- `CALENDAR_PERMISSION_INVALID`
- `PERMISSION_DENIED`

## Domain / Outbox Events

- `CALENDAR_CREATED`
- `CALENDAR_UPDATED`
- `CALENDAR_PERMISSION_CHANGED`

## Audit Events / Evidence

- `Calendar permission changes and destructive operations are audited.`

## Dependencies / Integrations

- Workspace org/Departments
- Projects
- Authorization

## Testing Requirements

- Department membership changes.
- Cross-workspace owner/department/project.
- Permission override.

## Acceptance Criteria

- All four calendar types can be created/queried according to allowed policy.
- Users cannot discover unauthorized private calendars.
