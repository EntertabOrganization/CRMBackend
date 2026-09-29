# Channels and Connectors Specification

> **Backend-only implementation scope:** This specification authorizes server-side work only: database schema and migrations, domain/application services, REST APIs, authorization, audit/outbox events, workers/jobs, provider adapters, and automated backend tests. Do not create, modify, scaffold, or test frontend pages, UI components, browser views, styling, or client-side application code. Any UI/browser wording below defines backend-facing behavior or security constraints only.


## Goal

Isolate WhatsApp, Email, Web Chat, SMS, Telephony and messenger provider differences behind normalized channel connection and connector interfaces.

## Channel vs connection

- **Channel** = Workspace business configuration, e.g. Support WhatsApp or Sales Inbox.
- **Connection** = provider account/credential/webhook integration backing the Channel.

Credentials live in secure secret storage, not normal business fields.

## Connection model

Logical fields:

```text
id UUID
workspaceId UUID
channelId UUID
providerKey string
channelType enum
status DISCONNECTED | CONNECTING | ACTIVE | DEGRADED | DISABLED | ERROR
externalAccountId nullable string
capabilities JSON/typed config
secretReference secure-config reference
webhookVerification metadata
healthStatus
lastCheckedAt nullable timestamptz
```

## Connector interface

Applicable equivalents:

```text
verifyInbound(request): VerifiedInboundEvent
normalizeInbound(event): NormalizedChannelEvent
sendMessage(input): ProviderSendResult
fetchDeliveryState?(externalMessageId)
registerWebhook?()
healthCheck?()
capabilities()
```

Telephony may extend this with call lifecycle/recording retrieval. Email may use mailbox synchronization in addition to webhooks.

## Normalized inbound event

Contains:
- provider/connection;
- unique external event ID where available;
- external conversation/thread/chat ID;
- external customer identity;
- external message/call ID;
- event type;
- occurrence timestamp;
- text/media/attachment references;
- delivery/status metadata;
- reply/reference metadata.

Raw provider payload is not copied wholesale into business fields. If retained for support, it follows secure provider-event retention.

## Inbound flow

1. resolve Connection from server route/configuration;
2. verify provider authenticity;
3. persist/dedupe external event;
4. normalize identity/event;
5. find/create Customer Identity;
6. find/reopen/create Conversation according to policy;
7. persist Message/call event;
8. route/assign when needed;
9. emit CRM/Timeline/Notification/Realtime events after commit.

## Outbound flow

1. authorize human sender and Conversation state;
2. persist local outbound Message with client/idempotency ID and `QUEUED`;
3. commit/outbox or enqueue delivery;
4. connector sends;
5. store external Message ID;
6. update normalized delivery state idempotently.

Provider retry cannot create a second local Message.

## Delivery states

Normalized superset:

```text
QUEUED
SENT
DELIVERED
READ
FAILED
```

Never fabricate a provider-unsupported state.

## Webhook/security

- signature/token verification where supported;
- server-derived connection/Workspace;
- external event uniqueness;
- replay safety;
- request-size limits;
- raw body only when verification requires it;
- secret/content redaction in logs according to privacy policy.

## Email

Thread/mailbox identity maps messages to Conversations according to configured threading/reopen rules. Normalize sender/recipient. Prevent synchronization loops using external IDs.

## Telephony

Store call metadata and recording references through secure Files/media storage. Recording access requires `conversation.view_recording`. Recording/transcription retention follows Workspace legal/consent policy.

## Errors

```text
CHANNEL_CONNECTION_NOT_FOUND
CHANNEL_CONNECTION_INACTIVE
CHANNEL_PROVIDER_VERIFICATION_FAILED
CHANNEL_EVENT_DUPLICATE
CHANNEL_EVENT_INVALID
CHANNEL_SEND_NOT_SUPPORTED
CHANNEL_SEND_FAILED
CHANNEL_PROVIDER_RATE_LIMITED
```

## Acceptance criteria

- same normalized service supports multiple provider adapters;
- duplicate inbound event persists one Message;
- outbound retry has one local Message/business effect;
- provider secrets never appear in normal API response/log;
- invalid verification cannot inject event;
- delivery states reconcile safely and do not invent unsupported provider semantics.
