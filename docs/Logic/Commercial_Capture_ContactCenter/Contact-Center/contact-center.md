# Contact Center Core Specification

> **Backend-only implementation scope:** This specification authorizes server-side work only: database schema and migrations, domain/application services, REST APIs, authorization, audit/outbox events, workers/jobs, provider adapters, and automated backend tests. Do not create, modify, scaffold, or test frontend pages, UI components, browser views, styling, or client-side application code. Any UI/browser wording below defines backend-facing behavior or security constraints only.


## Goal / Boundary

Centralize external customer communication and link it to CRM while remaining separate from internal employee Chat/Feed.

Contact Center owns channels/connections, customer channel identities, customer Conversations, external Messages/calls, routing/assignment state and CRM bindings.

## Supported architecture

Normalized connector architecture supports initial/future channel types including:

```text
WEB_CHAT
WHATSAPP
TELEGRAM
SOCIAL_MESSENGER
EMAIL
SMS
TELEPHONY
CALLBACK
CUSTOM_CONNECTOR
```

A channel type does not imply every provider supports every capability.

## Main entities

```text
communication_channels
channel_connections
contact_center_queues
contact_center_queue_members
customer_channel_identities
customer_conversations
conversation_messages
conversation_crm_bindings
conversation_assignments
conversation_transfers
message_delivery_events
contact_center_sla_policies
contact_center_quick_replies
provider_event/dedupe records through integration layer
```

Everything is Workspace-scoped or strongly inherits Workspace through connection/conversation.

## Customer identity resolution

Normalize identity by channel:
- phone -> canonical phone normalization;
- email -> normalized email;
- provider user/channel ID -> exact provider/connection scoped identity;
- web visitor/session -> stable permitted identity until CRM-linked.

Resolution order favors confirmed existing channel identity bindings, then high-confidence deterministic CRM matches.

If several eligible CRM candidates remain, mark ambiguous and require controlled resolution. Never choose randomly.

Unknown-customer policy per channel/queue:

```text
CREATE_CONTACT
CREATE_LEAD
KEEP_UNLINKED
REQUIRE_AGENT_CONFIRMATION
```

CRM creation goes through CRM services and duplicate rules.

## CRM binding

Conversation may bind to Contact/Company and optionally Deal/other allowed context. All bindings are same Workspace.

Significant communication generates Activities/Timeline projections through events; Contact Center remains owner of source Message truth.

## AI policy

Allowed:
- conversation summary;
- intent/classification/tag extraction;
- call/voice transcription where permitted;
- structured CRM field suggestions;
- suggested agent replies.

Automatic enrichment is allowed subject to Workspace AI/consent/retention policy.

**AI may not autonomously send customer-facing replies under this pack.** A human with `conversation.respond` performs send.

AI output is derived and never replaces/deletes source Messages/recordings.

## Permissions

```text
contact_center.channel_manage
contact_center.queue_manage
conversation.read
conversation.respond
conversation.assign
conversation.transfer
conversation.close
conversation.reopen
conversation.bind_crm
conversation.view_recording
conversation.ai_assist
```

Scopes may apply to queue/team/department/customer context.

## API

```text
GET  /api/v1/contact-center/conversations
GET  /api/v1/contact-center/conversations/:id
POST /api/v1/contact-center/conversations/:id/messages
POST /api/v1/contact-center/conversations/:id/assign
POST /api/v1/contact-center/conversations/:id/transfer
POST /api/v1/contact-center/conversations/:id/close
POST /api/v1/contact-center/conversations/:id/reopen
POST /api/v1/contact-center/conversations/:id/crm-bindings
GET  /api/v1/contact-center/channels
POST /api/v1/contact-center/channels
```

## Events

```text
CONVERSATION_CREATED
CONVERSATION_ASSIGNED
CONVERSATION_TRANSFERRED
CONVERSATION_CLOSED
CONVERSATION_REOPENED
CONVERSATION_CRM_BOUND
MESSAGE_RECEIVED
MESSAGE_QUEUED
MESSAGE_SENT
MESSAGE_DELIVERED
MESSAGE_READ
MESSAGE_FAILED
SLA_BREACHED
```

## Acceptance criteria

- internal employee Chat is never confused with customer Conversations;
- returning confirmed identity matches correct CRM customer when deterministic;
- ambiguous identity does not silently bind wrong customer;
- duplicate provider event does not duplicate Message;
- unauthorized agent cannot read/respond;
- history persists through assignment/transfer;
- AI suggestion cannot bypass human send permission;
- CRM bindings are same Workspace.
