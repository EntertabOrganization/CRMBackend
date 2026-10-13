# Feed, Chat & Internal Communication — Domain Overview

## Goal / Scope

Define internal Feed broadcasts, direct/group/system-managed Chats, durable Messages, Channels, Collabs and internal Calls while keeping customer Contact Center conversations separate.

## Ownership / Boundary

Communication owns internal durable communication and realtime fanout coordination. PostgreSQL is durable truth; Redis/WebSocket handles ephemeral presence/typing/fanout. Files, Tasks and Calendar remain owning domains for their referenced objects.

## Entities / Fields / Enums

Core tables/aggregates:

```text
feed_posts
feed_post_recipients
feed_post_audience_snapshots
feed_comments
feed_post_reads
feed_announcements
feed_announcement_acknowledgements
content_mentions
content_reactions
content_favorites
polls
poll_options
poll_votes
chats
direct_chat_pairs
chat_members
chat_membership_sources
chat_messages
chat_message_versions
chat_message_reads
chat_message_pins
chat_drafts
chat_user_recents
channels
channel_members
channel_membership_sources
channel_posts
channel_comments
collabs
collab_members
communication_calls
communication_call_participants
message_retention_policies
message_legal_holds
communication_bindings
```

```text
ChannelVisibility = PUBLIC | PRIVATE
ChannelRole = OWNER | ADMIN | PUBLISHER | SUBSCRIBER
MessageActor = USER | SYSTEM | BOT
```


## Business Rules / Validation

- Feed, Chat, Channel and Collab are distinct concepts/tables.
- Persist communication before realtime fanout.
- clientMessageId dedupes Message retries.
- Membership can have multiple sources and is removed only when all sources are gone.
- External people use Collab, not internal Chat/Channel.
- Message retention defaults indefinite and is independent from File retention.
- Task Chat membership derives from Task access.

## Permissions

- `FEED.*`
- `CHAT.*`
- `CHANNEL.*`
- `COLLAB.*`
- `CALL.*`

## Tenant / Ownership Rules

- All business rows and queries are scoped to the resolved active Workspace.
- Cross-Workspace IDs must not be linkable or inferable through this API.
- Resource-level authorization is re-evaluated server-side on every operation; possession of an ID is never authorization.

## Domain / Outbox Events

- `FEED_POST_PUBLISHED`
- `FEED_COMMENT_ADDED`
- `ANNOUNCEMENT_PUBLISHED`
- `CHAT_CREATED`
- `CHAT_MEMBER_CHANGED`
- `CHAT_MESSAGE_SENT`
- `CHAT_MESSAGE_EDITED`
- `CHAT_MESSAGE_DELETED`
- `MESSAGE_REACTED`
- `CHANNEL_POST_PUBLISHED`
- `COLLAB_MEMBER_CHANGED`
- `CALL_STARTED`
- `CALL_ENDED`

## Audit Events / Evidence

- `Permission/membership/retention/Legal Hold/moderation/external guest changes are centrally audited.`

## Dependencies / Integrations

- Users/Departments/Projects
- Files
- Tasks
- Calendar
- Notifications
- Search
- Realtime
- provider media adapter

## Testing Requirements

- Durable Message survives missed realtime.
- Duplicate sends dedupe.
- Access source recomputation.
- External Collab isolation.
- Retention vs Legal Hold.

## Acceptance Criteria

- Reconnect/reload recovers durable content.
- Department/project membership changes update sourced access safely.
- External collaborator cannot browse non-Collab Workspace content.
