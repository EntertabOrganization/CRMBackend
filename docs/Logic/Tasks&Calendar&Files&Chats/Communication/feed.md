# Feed Specification

## Goal / Scope

Implement recipient-based internal broadcast posts, comments, mentions/tags, announcements/acknowledgements, appreciation, polls, reactions, favorites, pins and read state.

## Ownership / Boundary

`FeedController` owns Feed content and audience semantics. Feed is not Chat and must not reuse Chat participant access as its authorization model.

## Entities / Fields / Enums

```text
feed_posts:
 id, workspaceId, authorUserId,
 postType STANDARD|ANNOUNCEMENT|APPRECIATION|POLL,
 title nullable, body,
 visibilityMode, status DRAFT|PUBLISHED|DELETED,
 isPinned, publishedAt, editedAt nullable, version

feed_post_recipients:
 postId, recipientType WORKSPACE|USER|DEPARTMENT|PROJECT, recipientId nullable

feed_post_audience_snapshots:
 postId, userId, reason, publishedAt
```
Normal Feed uses dynamic recipient resolution. Announcement/compliance posts snapshot eligible audience at publish time for read/ack metrics.

## API Endpoints

```text
POST   /api/v1/feed/posts
GET    /api/v1/feed
GET    /api/v1/feed/posts/:id
PUT    /api/v1/feed/posts/:id
PATCH  /api/v1/feed/posts/:id
DELETE /api/v1/feed/posts/:id
PATCH  /api/v1/feed/posts/:id/restore
DELETE /api/v1/feed/posts/:id/hard
POST   /api/v1/feed/posts/:id/publish
GET    /api/v1/feed/posts/:id/comments
POST   /api/v1/feed/posts/:id/comments
PATCH  /api/v1/feed/comments/:id
DELETE /api/v1/feed/comments/:id
POST   /api/v1/feed/posts/:id/reactions
DELETE /api/v1/feed/posts/:id/reactions/:reaction
POST   /api/v1/feed/posts/:id/favorite
DELETE /api/v1/feed/posts/:id/favorite
POST   /api/v1/feed/posts/:id/pin
DELETE /api/v1/feed/posts/:id/pin
POST   /api/v1/feed/posts/:id/read
POST   /api/v1/feed/posts/:id/acknowledge
GET    /api/v1/feed/posts/:id/read-stats
POST   /api/v1/feed/posts/:id/polls
POST   /api/v1/polls/:pollId/votes
DELETE /api/v1/polls/:pollId/votes/me
```

## Business Rules / Validation

- Workspace-wide publication requires `FEED.POST_WORKSPACE` or equivalent.
- Normal author may target only audiences allowed by permission/scope.
- Normal Feed audience is dynamically resolved; joining a Department later can reveal prior normal Department posts subject to retention.
- Announcement/compliance audience is snapshotted when published so acknowledgement metrics are stable.
- Poll eligible audience follows container/audience at publication; anonymous poll must not expose voter identity through ordinary result API.
- Soft-deleted post is removed from normal feed but central/domain history remains.
- Mentions notify only users who are actually authorized to view the post.

## Permissions

- `FEED.POST`
- `FEED.POST_WORKSPACE`
- `FEED.READ`
- `FEED.UPDATE_OWN`
- `FEED.DELETE_OWN`
- `FEED.MODERATE`
- `FEED.ANNOUNCEMENT`
- `FEED.POLL`

## Tenant / Ownership Rules

- All business rows and queries are scoped to the resolved active Workspace.
- Cross-Workspace IDs must not be linkable or inferable through this API.
- Resource-level authorization is re-evaluated server-side on every operation; possession of an ID is never authorization.

## Stable Error Cases

- `FEED_POST_NOT_FOUND`
- `FEED_AUDIENCE_NOT_ALLOWED`
- `FEED_POST_NOT_PUBLISHED`
- `FEED_ACK_NOT_REQUIRED`
- `POLL_NOT_OPEN`
- `POLL_ALREADY_VOTED`
- `PERMISSION_DENIED`

## Domain / Outbox Events

- `FEED_POST_PUBLISHED`
- `FEED_COMMENT_ADDED`
- `ANNOUNCEMENT_PUBLISHED`
- `ANNOUNCEMENT_ACKNOWLEDGED`
- `POLL_CREATED`
- `POLL_VOTED`

## Audit Events / Evidence

- `Moderator hard delete, announcement/security-sensitive publication and Workspace-wide policy changes are audited; normal content itself remains durable evidence.`

## Dependencies / Integrations

- Departments/Projects
- Files attachments
- Notifications
- Search
- Realtime

## Testing Requirements

- Dynamic vs snapshot audience.
- Mention unauthorized user.
- Anonymous poll privacy.
- Workspace-wide permission.

## Acceptance Criteria

- Feed audience cannot leak posts to unauthorized users.
- Announcement acknowledgement denominator remains stable.
