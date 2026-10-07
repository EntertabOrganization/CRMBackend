# Internal Calls Specification

## Goal / Scope

Implement call/business state, participants, recordings/bindings and secure conference access while delegating media transport to a provider/SFU adapter.

## Ownership / Boundary

`CallsController` owns call lifecycle metadata and authorization. Media negotiation/rooms/recording transport belong to provider adapter. Recordings are Files.

## Entities / Fields / Enums

```text
communication_calls:
 id, workspaceId, chatId nullable, collabId nullable,
 callType AUDIO|VIDEO,
 startedByUserId,
 status RINGING|ACTIVE|ENDED|FAILED|CANCELLED,
 provider, providerRoomId,
 recordingFileId nullable,
 startedAt, endedAt nullable, version

communication_call_participants:
 id, workspaceId, callId, userId nullable,
 externalGuestId nullable,
 joinedAt nullable, leftAt nullable, status
```
External conference guest tokens are scoped to the call and confer no Chat/Workspace membership.

## API Endpoints

```text
POST   /api/v1/calls
GET    /api/v1/calls
GET    /api/v1/calls/:id
POST   /api/v1/calls/:id/join
POST   /api/v1/calls/:id/leave
POST   /api/v1/calls/:id/end
POST   /api/v1/calls/:id/cancel
GET    /api/v1/calls/:id/participants
POST   /api/v1/calls/:id/external-invitations
POST   /api/v1/public/calls/:token/join
GET    /api/v1/calls/:id/recording
```

## Business Rules / Validation

- Caller must be authorized for linked Chat/Collab context.
- Provider room created idempotently for call start.
- External guest token joins only call; it cannot read Chat history or Workspace directory.
- Provider failure updates durable FAILED state visibly.
- Ending call is idempotent.
- Recording, if enabled and consent/policy permits, is stored through File service and linked by fileId.

## Permissions

- `CALL.CREATE`
- `CALL.READ`
- `CALL.JOIN`
- `CALL.END`
- `CALL.EXTERNAL_INVITE`
- `CALL.RECORDING_READ`

## Tenant / Ownership Rules

- All business rows and queries are scoped to the resolved active Workspace.
- Cross-Workspace IDs must not be linkable or inferable through this API.
- Resource-level authorization is re-evaluated server-side on every operation; possession of an ID is never authorization.

## Stable Error Cases

- `CALL_NOT_FOUND`
- `CALL_INVALID_STATE`
- `CALL_PROVIDER_ERROR`
- `CALL_EXTERNAL_TOKEN_INVALID`
- `CALL_ACCESS_DENIED`
- `PERMISSION_DENIED`

## Domain / Outbox Events

- `CALL_STARTED`
- `CALL_PARTICIPANT_JOINED`
- `CALL_PARTICIPANT_LEFT`
- `CALL_ENDED`
- `CALL_FAILED`
- `CALL_RECORDING_AVAILABLE`

## Audit Events / Evidence

- `External invitations, provider/security configuration and recording-sensitive changes are audited as applicable.`

## Dependencies / Integrations

- Media provider adapter
- Files
- Chat/Collab
- Realtime
- Notifications

## Testing Requirements

- Provider start failure.
- End retry.
- External token access scope.
- Recording permission.

## Acceptance Criteria

- TrueCRM call history survives provider/realtime failure.
- External call guest cannot access linked Chat content.
