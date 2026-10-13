# Requisite Presets and Addresses Specification

> **Backend-only implementation scope:** This specification authorizes server-side work only: database schema and migrations, domain/application services, REST APIs, authorization, audit/outbox events, workers/jobs, provider adapters, and automated backend tests. Do not create, modify, scaffold, or test frontend pages, UI components, browser views, styling, or client-side application code. Any UI/browser wording below defines backend-facing behavior or security constraints only.


## Goal

Configure country + legal entity/person schemas and store multiple typed addresses per Requisite.

## Presets

`requisite_presets`:

```text
id UUID
workspaceId nullable for system preset / UUID for custom preset
countryCode string
entityTypeCode string
name string
active boolean
version/config metadata
```

`requisite_preset_fields`:

```text
fieldCode
label
type
required
multiple
sortOrder
validation rule identifier/config
visibility/edit policy
system/custom marker
```

System presets may be copied/extended by Workspace-specific configuration. A Workspace cannot mutate shared global preset behavior for other tenants.

## Entity types

At minimum support configurable distinction such as:

```text
COMPANY
INDIVIDUAL
```

The system is extensible by country; do not hard-code only one or two countries.

## Preset validation

On Requisite create/update:
- resolve eligible preset;
- validate required fields;
- reject unknown protected field codes;
- validate field type/format;
- preserve preset/schema identity needed to interpret saved values.

Changing a preset does not rewrite historical commercial snapshots.

If a preset adds a new required field affecting existing current Requisites, use explicit compatibility/migration handling rather than silently corrupting or blocking unrelated historical documents.

## Addresses

Logical `requisite_addresses`:

```text
id UUID
workspaceId UUID
requisiteId UUID
type LEGAL | REGISTERED | BILLING | SHIPPING | MAILING | OTHER
countryCode string
region/state/province nullable
city nullable
postalCode nullable
line1 string
line2 nullable
building/unit metadata nullable
isDefaultForType boolean
active boolean
```

Country/preset may define additional structured fields.

## Address rules

- multiple address types allowed;
- multiple same-type addresses allowed when configured, with at most one default per defined context;
- address belongs to same Workspace/Requisite;
- archive rather than delete when referenced;
- commercial document uses snapshot, not live address join;
- default/type changes are audited where they affect document selection.

## API

```text
GET/POST/PATCH /api/v1/requisite-presets...
GET  /api/v1/requisites/:id/addresses
POST /api/v1/requisites/:id/addresses
PATCH /api/v1/requisites/:id/addresses/:addressId
POST /api/v1/requisites/:id/addresses/:addressId/set-default
POST /api/v1/requisites/:id/addresses/:addressId/archive
```

Preset administration uses appropriate configuration/admin permission.

## Acceptance criteria

- different country/entity combinations can require different fields without deployment;
- invalid/missing required preset field is rejected;
- one Requisite can hold Legal + Billing + Shipping addresses;
- commercial snapshot stays stable after address edit;
- preset change does not rewrite old documents;
- cross-Workspace preset/address access fails.
