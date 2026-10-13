# Traffic Sources, Visitor Tracking & Identity Specification

## Goal

Capture source evidence from online/offline interactions, maintain privacy-aware visitor/session journeys, and deterministically link permitted anonymous history to known CRM identities.

## Traffic source registry

Source type examples:

```text
PAID_SEARCH
PAID_SOCIAL
ORGANIC_SEARCH
ORGANIC_SOCIAL
DIRECT
REFERRAL
EMAIL
PARTNER
EVENT
PRINT
BILLBOARD
RADIO
CALL_TRACKING
PROMO
OTHER
```

Provide built-in common sources plus workspace-defined sources.

Suggested source fields:

```text
id
workspaceId
code
name
category
isSystem
isEnabled
providerKey nullable
parentSourceId nullable
```

System sources may be protected from destructive deletion but can be disabled where policy permits.

## Source-resolution rules

A rule maps evidence to a traffic source.

Evidence types:
- managed tracking-link ID,
- provider/ad click/campaign identifiers,
- dedicated tracking phone number,
- dedicated inbound email alias/address,
- promo code,
- UTM parameters,
- referrer domain,
- direct/unknown fallback.

Rules are versioned if changing them would alter historical interpretation.

## Default evidence precedence

For an individual touch, use deterministic precedence:

1. trusted managed tracking identifier/link;
2. dedicated tracking phone/email/promo identifier;
3. recognized provider campaign/ad evidence;
4. explicit UTM mapping;
5. configured referrer-domain rule;
6. Direct/Other/Unknown.

A workspace may configure supported precedence/rules but must keep resolution deterministic.

## Source-resolution output

Every touch should store:
- resolved source ID,
- source-rule/version,
- evidence type,
- sanitized raw evidence needed to explain the match,
- resolution confidence/type,
- occurredAt.

The system must be able to answer: "Why was this touch classified as source X?"

## UTM support

Capture standard:
- `utm_source`
- `utm_medium`
- `utm_campaign`
- `utm_term`
- `utm_content`

Preserve values subject to privacy/retention rules.

Do not assume UTM alone is always higher priority than a trusted managed tracking identifier.

## Referrer detection

Normalize referrer host and match configured domains.

Do not classify arbitrary referrer strings without validation.

Unknown unmatched traffic falls to configured Other/Direct behavior.

## Visitor

A visitor is an anonymous first-party identity within one workspace/site context, subject to privacy policy.

Suggested:

```text
id
workspaceId
publicVisitorId
firstSeenAt
lastSeenAt
consentState/version
status
```

Do not store fingerprint-derived invasive device signatures by default.

`publicVisitorId` must be random/high entropy and not expose database IDs.

## Visitor session

Suggested:

```text
id
workspaceId
visitorId
siteId nullable
sessionPublicId
startedAt
endedAt nullable
landingUrl sanitized
referrerHost nullable
deviceClass coarse nullable
consentSnapshot
```

Avoid collecting unnecessary sensitive data.

## Touch

Touch types may include:

```text
PAGE_ENTRY
FORM_SUBMISSION
CALL
MESSAGE
EMAIL
TRACKING_LINK_CLICK
PROMO_REDEMPTION
OFFLINE_IMPORT
MANUAL_SOURCE
```

Suggested fields:

```text
id
workspaceId
visitorId nullable
sessionId nullable
crmCustomerType/id nullable
dealId nullable
sourceId
sourceRuleVersion
touchType
occurredAt
campaign/ad references nullable
utm fields nullable
evidenceJson sanitized
```

## Privacy/consent

Tracking behavior must consume workspace/site cookie/privacy configuration.

Possible modes may include:
- no anonymous persistence before consent,
- essential first-party identifier only,
- full permitted analytics attribution tracking.

The exact modes should reuse existing Sites/Privacy configuration rather than inventing a second consent system.

If consent is withdrawn, retention/deletion/anonymization follows central policy while preserving required business/legal aggregates where lawful/configured.

## Deterministic identity linking

Allowed evidence examples:
- authenticated portal/customer identity,
- validated CRM Form result,
- exact normalized email/phone match through authorized CRM resolution,
- channel provider identity linked to CRM,
- explicit signed customer/reference token,
- stable commerce customer identifier.

Do not default to probabilistic browser/device fingerprint matching.

## Identity link

Suggested:

```text
id
workspaceId
visitorId
crmEntityType CONTACT|COMPANY|LEAD as allowed
crmEntityId
linkMethod
evidenceRef
linkedAt
confidence DETERMINISTIC
```

If a Lead later converts, link migration should follow CRM conversion events rather than mutating history incorrectly.

## Customer acquisition source

Customer acquisition source is a derived/stored marketing property separate from operational creation source.

Default:
- first qualifying touch according to attribution/acquisition settings,
- source may be manually overridden only with permission,
- original evidence and previous value remain audit/history.

## Deal opportunity source

When a Deal is created:
- determine opportunity source using current qualifying touch/window policy;
- do not overwrite the customer's acquisition source;
- store the Deal's own source/evidence separately.

## Managed tracking links

Create redirect links:

Suggested fields:
```text
id
workspaceId
publicToken
destinationUrl
sourceId
campaign/ad metadata nullable
utmTemplate nullable
status
createdBy
```

Click flow:
1. resolve public token;
2. rate-limit/validate;
3. record permitted click/session touch;
4. redirect to validated destination.

Security:
- prevent open redirect to unauthorized/malformed schemes;
- destination restricted to http/https unless explicitly supported;
- no internal admin URL leakage.

## Static call tracking

V1:
- map dedicated inbound number → source/campaign;
- telephony integration reports destination tracking number and caller identity;
- create CALL touch;
- link to CRM customer when identity resolution succeeds.

Architecture should permit future dynamic number pools without changing core touch/source schema.

## Email-source tracking

Where mailbox/provider supports receiving-alias identity:
- map alias/address → source/campaign;
- inbound customer email records EMAIL touch;
- link via Communication/CRM identity resolution.

## Promo/offline tracking

Promo code or offline import may create touch/source evidence with actor/provider provenance.

Manual source input must never masquerade as automatically observed evidence.

## APIs

Administrative:

```text
GET/POST/PATCH /api/v1/sales-intelligence/sources...
GET/POST/PATCH /api/v1/sales-intelligence/source-rules...
GET/POST/PATCH /api/v1/sales-intelligence/tracking-links...
GET/POST/PATCH /api/v1/sales-intelligence/tracking-numbers...
GET/POST/PATCH /api/v1/sales-intelligence/tracking-email-aliases...
```

Operational/inspection:

```text
GET /api/v1/sales-intelligence/visitors/:id
GET /api/v1/sales-intelligence/touches
POST /api/v1/sales-intelligence/customers/:type/:id/source-override
```

Public tracking-link endpoint should be outside authenticated `/api/v1` if existing public routing convention requires it, but must be server-controlled/rate-limited.

## Audit

Audit:
- source/rule changes,
- tracking asset configuration,
- manual customer/Deal source override.

Routine page/touch events are operational facts rather than central audit entries.

## Acceptance criteria

- UTM/referrer/tracking-link evidence resolves consistently.
- Manual override does not erase original evidence.
- Anonymous visitor IDs are random and workspace/site scoped.
- No probabilistic fingerprinting is required.
- Identity link never links across workspace.
- Customer acquisition source and new Deal opportunity source can differ.
- Static call number identifies correct source.
- Tracking link cannot become an open redirect.
- User without CRM access cannot retrieve restricted customer details through touch endpoints.
