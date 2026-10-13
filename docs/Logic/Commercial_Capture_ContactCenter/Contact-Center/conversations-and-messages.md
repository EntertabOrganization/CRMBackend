# Conversations and Messages Specification

> **Backend-only implementation scope:** This specification authorizes server-side work only: database schema and migrations, domain/application services, REST APIs, authorization, audit/outbox events, workers/jobs, provider adapters, and automated backend tests. Do not create, modify, scaffold, or test frontend pages, UI components, browser views, styling, or client-side application code. Any UI/browser wording below defines backend-facing behavior or security constraints only.


## Goal

Implement durable session-based customer Conversations, Message history, close/reopen behavior, CRM/customer binding, assignment history and transfer.

## Conversation entity

```text
id UUID
workspaceId UUID
channelId UUID
queueId nullable UUID
status OPEN | WAITING_AGENT | WAITING_CUSTOMER | CLOSED
customerIdentityId UUID
primaryContactId nullable UUID
primaryCompanyId nullable UUID
currentAssigneeUserId nullable UUID
openedAt timestamptz
closedAt nullable timestamptz
lastCustomerMessageAt nullable timestamptz
lastAgentMessageAt nullable timestamptz
reopenUntil nullable timestamptz
priority NORMAL | HIGH | URGENT
```

One customer identity may have multiple Conversations over time.

## Conversation creation/reopen

On new inbound customer event:
1. find most recent eligible Conversation for Channel/customer identity;
2. if OPEN/waiting -> append;
3. if CLOSED and now <= configured `reopenUntil` -> reopen same Conversation;
4. otherwise create a new Conversation/session;
5. route if unassigned.

Reopen window is configured per queue/channel.

## Messages

Logical fields:

```text
id UUID
workspaceId UUID
conversationId UUID
direction INBOUND | OUTBOUND | SYSTEM
senderType CUSTOMER | USER | SYSTEM | PROVIDER
senderUserId nullable UUID
externalMessageId nullable string
clientMessageId/idempotencyKey nullable string
messageType TEXT | FILE | IMAGE | AUDIO | VIDEO | CALL_EVENT | SYSTEM
body text/structured safe representation
occurredAt timestamptz
deliveryStatus nullable normalized state
replyToMessageId nullable UUID
```

Dedupe constraints are scoped to provider/Connection + external IDs, not global across providers.

Provider edits/deletions, if supported, create version/state history instead of silently rewriting history.

## Respond

```text
POST /api/v1/contact-center/conversations/:id/messages
```

Rules:
- caller has `conversation.respond`;
- assignment/queue policy permits caller;
- Conversation state permits send;
- assigned agent normally responds; authorized supervisor/queue user may respond by policy;
- persist local Message before provider delivery;
- client/idempotency ID protects retry;
- attachment must be accessible and clean;
- delivery may be asynchronous.

## Assign

```text
POST /api/v1/contact-center/conversations/:id/assign
```

Validate target agent and queue/channel access. Automatic routing may not ignore availability/capacity. Manual manager override must be explicit and audited.

Record assignment history.

## Transfer

```text
POST /api/v1/contact-center/conversations/:id/transfer
```

Input chooses target user or queue and optional/required reason.

Transaction:
- authorize;
- validate target;
- keep same Conversation ID and Messages;
- close previous assignment-history entry;
- append transfer record with from/to/actor/time/reason;
- set new assignee/queue or enqueue routing;
- audit + outbox.

Transfer does not create a disconnected new Conversation.

## Close/reopen

Close sets CLOSED, close metadata and `reopenUntil`, and completes resolution SLA according to policy.

Inbound within window may reopen automatically. Explicit manual reopen requires permission.

## CRM bindings

Conversation can bind to Contact/Company/Deal. Binding changes are audited. Ambiguous identity can stay temporarily unbound without losing communication.

## Search/filter

At least:
- status;
- channel;
- queue;
- assignee;
- CRM customer;
- priority;
- SLA/breach state;
- last-activity range.

Search results/snippets must obey Conversation access.

## Acceptance criteria

- same customer can have multiple historical sessions;
- close/reopen window works exactly as configured;
- transfer preserves all Messages and history;
- duplicate inbound/outbound identifiers do not duplicate Messages;
- unauthorized user cannot respond with known UUID;
- concurrent assignment/transfer has deterministic conflict behavior;
- closed Conversations remain searchable to authorized users under retention policy.
