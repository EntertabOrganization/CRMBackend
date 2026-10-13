# Channels Specification

## Goal / Scope

Implement PUBLIC/PRIVATE subscription publishing spaces with owner/admin/publisher/subscriber roles and durable per-post discussions.

## Ownership / Boundary

`ChannelsController` owns Channel configuration, membership/subscription and Channel posts/comments. Channel is not a group Chat.

## Entities / Fields / Enums

```text
channels:
 id, workspaceId, name, description,
 visibility PUBLIC|PRIVATE,
 ownerUserId, status ACTIVE|ARCHIVED,
 version

channel_members:
 channelId, userId,
 role OWNER|ADMIN|PUBLISHER|SUBSCRIBER,
 joinedAt, leftAt nullable

channel_membership_sources:
 channelId, userId, sourceType MANUAL|DEPARTMENT|PROJECT|SYSTEM, sourceId, active

channel_posts:
 id, workspaceId, channelId, authorUserId,
 title nullable, body, status PUBLISHED|DELETED,
 publishedAt, editedAt nullable, version
```
Comments/discussions are scoped under one Channel Post.

## API Endpoints

```text
POST   /api/v1/channels
GET    /api/v1/channels
GET    /api/v1/channels/:id
PUT    /api/v1/channels/:id
PATCH  /api/v1/channels/:id
DELETE /api/v1/channels/:id
POST   /api/v1/channels/:id/archive
GET    /api/v1/channels/:id/members
POST   /api/v1/channels/:id/members
PATCH  /api/v1/channels/:id/members/:userId
DELETE /api/v1/channels/:id/members/:userId
POST   /api/v1/channels/:id/subscribe
POST   /api/v1/channels/:id/unsubscribe
GET    /api/v1/channels/:id/posts
POST   /api/v1/channels/:id/posts
GET    /api/v1/channel-posts/:id
PATCH  /api/v1/channel-posts/:id
DELETE /api/v1/channel-posts/:id
GET    /api/v1/channel-posts/:id/comments
POST   /api/v1/channel-posts/:id/comments
PATCH  /api/v1/channel-comments/:id
DELETE /api/v1/channel-comments/:id
```

## Business Rules / Validation

- PUBLIC Channel is discoverable/readable/subscribable by Workspace members subject to policy; PRIVATE Channel requires authorized membership/invitation.
- Only OWNER/ADMIN manage roles.
- Only OWNER/ADMIN/PUBLISHER publish; subscriber can read/discuss according to channel settings.
- Exactly one owner; transfer before owner removal.
- Department/project sourced membership follows multi-source removal rule.
- External users do not join normal Channels; use Collab.
- Archived Channel is read-only.

## Permissions

- `CHANNEL.CREATE`
- `CHANNEL.READ`
- `CHANNEL.UPDATE`
- `CHANNEL.MEMBER_MANAGE`
- `CHANNEL.PUBLISH`
- `CHANNEL.COMMENT`
- `CHANNEL.MODERATE`

## Tenant / Ownership Rules

- All business rows and queries are scoped to the resolved active Workspace.
- Cross-Workspace IDs must not be linkable or inferable through this API.
- Resource-level authorization is re-evaluated server-side on every operation; possession of an ID is never authorization.

## Stable Error Cases

- `CHANNEL_NOT_FOUND`
- `CHANNEL_PRIVATE`
- `CHANNEL_OWNER_REQUIRED`
- `CHANNEL_PUBLISH_DENIED`
- `CHANNEL_ARCHIVED`
- `PERMISSION_DENIED`

## Domain / Outbox Events

- `CHANNEL_CREATED`
- `CHANNEL_MEMBER_CHANGED`
- `CHANNEL_POST_PUBLISHED`
- `CHANNEL_ARCHIVED`

## Audit Events / Evidence

- `Owner/role/membership/moderation changes are audited.`

## Dependencies / Integrations

- Departments/Projects membership sync
- Files
- Notifications
- Search
- Realtime

## Testing Requirements

- Public discovery vs private.
- Owner removal.
- Publisher vs subscriber.
- Multi-source membership.

## Acceptance Criteria

- Subscriber cannot publish without role.
- External guest cannot access ordinary Channel.
