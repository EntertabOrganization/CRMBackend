# Chats & Messages Specification

## Goal / Scope

Implement direct/group/project/department/task Chats, multi-source membership, durable Messages, versions, reads, drafts, reactions, pins/favorites, replies and source-object bindings.

## Ownership / Boundary

`ChatsController` owns Chat metadata/membership. `MessagesController` owns durable Message operations. Task/Project/Department system-managed Chats derive membership from their owning source; users cannot independently bypass that policy.

## Entities / Fields / Enums

```text
chats:
 id, workspaceId,
 type DIRECT|GROUP|PROJECT|DEPARTMENT|TASK|COLLAB,
 title nullable, status ACTIVE|ARCHIVED,
 linkedEntityType nullable, linkedEntityId nullable,
 version

direct_chat_pairs:
 workspaceId, userAId, userBId, chatId
 UNIQUE(workspaceId, normalized pair)

chat_members:
 chatId, userId, role MEMBER|ADMIN|BOT,
 joinedAt, leftAt nullable, lastReadMessageId nullable

chat_membership_sources:
 chatId, userId,
 sourceType MANUAL|PROJECT|DEPARTMENT|TASK|COLLAB|SYSTEM,
 sourceId, active

chat_messages:
 id, workspaceId, chatId,
 senderType USER|SYSTEM|BOT, senderId nullable,
 clientMessageId,
 messageType TEXT|FILE|VOICE|VIDEO|SYSTEM,
 body nullable, replyToMessageId nullable,
 status ACTIVE|DELETED,
 sentAt, editedAt nullable, deletedAt nullable,
 version
 UNIQUE(chatId, senderId, clientMessageId) where applicable
```
Message versions preserve pre-edit bodies.

## API Endpoints

```text
POST   /api/v1/chats
GET    /api/v1/chats
GET    /api/v1/chats/:id
PUT    /api/v1/chats/:id
PATCH  /api/v1/chats/:id
POST   /api/v1/chats/direct
POST   /api/v1/chats/:id/archive
GET    /api/v1/chats/:id/members
POST   /api/v1/chats/:id/members
DELETE /api/v1/chats/:id/members/:userId
POST   /api/v1/chats/:id/leave
GET    /api/v1/chats/:id/messages
POST   /api/v1/chats/:id/messages
GET    /api/v1/messages/:id
PATCH  /api/v1/messages/:id
DELETE /api/v1/messages/:id
GET    /api/v1/messages/:id/versions
POST   /api/v1/messages/:id/reactions
DELETE /api/v1/messages/:id/reactions/:reaction
POST   /api/v1/messages/:id/pin
DELETE /api/v1/messages/:id/pin
POST   /api/v1/messages/:id/favorite
DELETE /api/v1/messages/:id/favorite
POST   /api/v1/chats/:id/read
POST   /api/v1/messages/:id/read
GET    /api/v1/chats/:id/draft
PUT    /api/v1/chats/:id/draft
DELETE /api/v1/chats/:id/draft
GET    /api/v1/messages/search
POST   /api/v1/messages/:id/create-task
POST   /api/v1/messages/:id/create-event
```

## Business Rules / Validation

- One canonical Direct Chat per same-Workspace permitted user pair.
- Persist Message + outbox before realtime.
- clientMessageId dedupes resend and returns original created message for same semantic retry.
- Membership may have multiple active sources; removing one source removes Chat access only if no valid source remains.
- Task Chat sources derive from Task creator/responsible/participant/observer/authorized relationship; no manual join bypass.
- Project/Department membership sync uses source rows.
- Sender edit/delete default window 24 hours; authorized moderator may act later.
- Edit stores version history. Delete produces tombstone.
- Quoted reply is supported; data model remains thread-ready without requiring full threaded subchat semantics.
- Read model hybrid: last-read position standard; exact receipts where product needs them for smaller contexts.
- Create Task/Event stores communication binding back to source Message.
- Link preview fetch must be SSRF-safe and asynchronous.

## Permissions

- `CHAT.CREATE`
- `CHAT.READ`
- `CHAT.UPDATE`
- `CHAT.MEMBER_MANAGE`
- `CHAT.MESSAGE_SEND`
- `CHAT.MESSAGE_EDIT_OWN`
- `CHAT.MESSAGE_DELETE_OWN`
- `CHAT.MODERATE`
- `CHAT.READ_RECEIPTS`

## Tenant / Ownership Rules

- All business rows and queries are scoped to the resolved active Workspace.
- Cross-Workspace IDs must not be linkable or inferable through this API.
- Resource-level authorization is re-evaluated server-side on every operation; possession of an ID is never authorization.

## Stable Error Cases

- `CHAT_NOT_FOUND`
- `CHAT_MEMBER_REQUIRED`
- `CHAT_MEMBERSHIP_SOURCE_PROTECTED`
- `MESSAGE_NOT_FOUND`
- `MESSAGE_EDIT_WINDOW_EXPIRED`
- `MESSAGE_DELETE_WINDOW_EXPIRED`
- `MESSAGE_CLIENT_ID_CONFLICT`
- `MESSAGE_SOURCE_OBJECT_CREATE_DENIED`
- `PERMISSION_DENIED`

## Domain / Outbox Events

- `CHAT_CREATED`
- `CHAT_MEMBER_CHANGED`
- `CHAT_MESSAGE_SENT`
- `CHAT_MESSAGE_EDITED`
- `CHAT_MESSAGE_DELETED`
- `MESSAGE_REACTED`
- `CHAT_READ_UPDATED`

## Audit Events / Evidence

- `Moderator deletion/membership-source/security-sensitive actions audited; normal Message content/version tables are ordinary evidence.`

## Dependencies / Integrations

- Users/Departments/Projects/Tasks/Collabs
- Files
- Tasks
- Calendar
- Realtime
- Notifications
- Search

## Testing Requirements

- Duplicate send.
- Missed realtime then reload.
- Remove one of multiple membership sources.
- Task Chat bypass attempt.
- Edit/delete expiry.
- Cross-workspace direct Chat.

## Acceptance Criteria

- A Message survives realtime failure.
- Retry does not create duplicate Message.
- System-managed Chat membership reflects source access without over-revoking other sources.
