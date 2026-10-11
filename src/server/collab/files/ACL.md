# Storage and folder ACL configuration

`GET /file-storages/:id/permissions` and `GET /folders/:id/permissions` return direct assignments and the current resource version. Both reads and writes require `file.permission_manage` plus effective FULL authority on the resource. A platform action grant alone cannot reveal the assignment list.

`PUT` replaces the complete direct assignment list. Supply `{ "version": 1, "assignments": [...] }`, or use `If-Match` for the resource version. Each assignment contains `subjectType`, `subjectId`, `permissionLevel` and `inheritanceMode`. An empty list restores inherited authority. The response reports the new resource version, even if the caller has intentionally removed their own access.

All direct assignments on one resource use one inheritance mode. INHERIT combines matching grants with parent authority; OVERRIDE replaces inherited authority with matching direct grants. NONE does not subtract an inherited grant in INHERIT mode. Project membership remains an independent live source, subject to child overrides. Copying a folder does not copy its direct ACLs.

Subjects must belong to this Workspace: active users, undeleted roles/departments, valid roles on a live linked Project, or external members of an active Workspace Collab. WORKSPACE accepts null or the current Workspace ID and stores null. Ordinary Workspace reads do not use EXTERNAL_GUEST assignments to grant membership or access; guest resource routes must separately validate their live authority.

Assignments are validated before changing any state. Replacement, resource version, audit and `FILE_PERMISSION_CHANGED` outbox evidence commit together. Persistence locks the Workspace revision and rejects stale graph, authorization or retention snapshots. PostgreSQL enforces subject tenancy, canonical subject uniqueness and a single direct inheritance mode, with deferred final-state constraints to permit atomic replacement.

Read-only content permits ACL administration by an authorized FULL manager, so security access can still be revoked. Inactive storage and trashed folder paths remain unavailable through these endpoints. File ACL and public-link routes are separate pending integrations.
