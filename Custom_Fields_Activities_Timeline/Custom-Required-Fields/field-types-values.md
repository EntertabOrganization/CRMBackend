# Field Types and Typed Values

## Supported types

Initial field types:

```text
TEXT
TEXTAREA
INTEGER
DECIMAL
BOOLEAN
DATE
DATETIME
LIST
MULTI_LIST
PHONE
EMAIL
URL
MONEY
USER_REFERENCE
CRM_REFERENCE
FILE
ADDRESS
```

`MULTI_LIST` is intrinsically multiple. Other compatible types may set `isMultiple = true`.

## Multiplicity

Allow multiplicity for types where an ordered collection has clear business meaning, including:

- TEXT / TEXTAREA where product UX supports it;
- INTEGER / DECIMAL;
- DATE / DATETIME;
- PHONE / EMAIL / URL;
- LIST;
- USER_REFERENCE;
- CRM_REFERENCE;
- FILE;
- ADDRESS.

Do not blindly enable multiplicity where the type handler declares it unsupported. `BOOLEAN` and `MONEY` should default to single value unless a repository/product extension explicitly supports a meaningful multi-value UX.

The field type registry must declare capabilities rather than scattering hard-coded checks.

## Field type handler contract

Suggested logical contract:

```ts
interface FieldTypeHandler<TInput, TNormalized> {
  readonly type: CustomFieldType;
  readonly supportsMultiple: boolean;
  normalize(input: unknown, context: FieldValidationContext): Promise<TNormalized>;
  validate(value: TNormalized, definition: FieldDefinition): Promise<FieldViolation[]>;
  serialize(value: TNormalized): TypedValueColumns;
  deserialize(row: TypedValueRow): TNormalized;
  supportedOperators(): FieldConditionOperator[];
}
```

## Typed value storage

Use one generic table with type-specific columns. A conceptual row:

```text
id UUID
workspaceId UUID
fieldId UUID
entityType
entityId UUID
ordinal integer
valueText nullable
valueInteger nullable
valueDecimal nullable
valueBoolean nullable
valueDate nullable
valueDateTime nullable
valueUuid nullable
valueJson nullable
createdAt
updatedAt
```

The exact columns may be adjusted to the repository ORM, but do not collapse all scalar values into one string or one untyped JSON document.

Suggested mapping:

| Field type | Storage |
|---|---|
| TEXT/TEXTAREA/PHONE/EMAIL/URL | `value_text` |
| INTEGER | `value_integer` |
| DECIMAL | `value_decimal` |
| BOOLEAN | `value_boolean` |
| DATE | `value_date` |
| DATETIME | `value_datetime` |
| LIST/MULTI_LIST | stable option ID in `value_uuid` or dedicated FK |
| USER_REFERENCE | user ID in `value_uuid` plus workspace validation |
| CRM_REFERENCE | structured reference; use dedicated reference columns/table if repository favors relational integrity |
| FILE | shared file ID, never file bytes |
| MONEY | precise amount + currency; use structured columns or validated JSON only for the pair |
| ADDRESS | validated structured value; JSON is acceptable for the structured address payload if schema-validated |

If a dedicated relation table is cleaner for CRM references/files, use it; preserve the typed-value behavior and workspace checks.

## Multi-value ordering

For `isMultiple = true`, store one value row per item with zero- or one-based `ordinal` consistently.

Replacement semantics for a normal record PATCH:

- when the field code is omitted: do not change its values;
- when the field code is present with an array: replace the complete ordered value set atomically;
- when present with an empty array: clear it, subject to required-field validation;
- reject duplicate values only for field types/configurations that declare uniqueness meaningful.

## API value shapes

Examples:

```json
{
  "customFields": {
    "customer_industry": "option-uuid",
    "estimated_users": 400,
    "vip": false,
    "renewal_date": "2027-03-01",
    "stakeholders": ["contact-ref-1", "contact-ref-2"],
    "budget": {"amount": "125000.00", "currency": "USD"},
    "office_address": {
      "line1": "100 Main St",
      "city": "Edmonton",
      "region": "AB",
      "postalCode": "T5J 0N3",
      "countryCode": "CA"
    }
  }
}
```

Never expose storage-column names in public DTOs.

## Empty-value semantics

The server uses these semantics consistently:

```text
missing key        = not supplied (PATCH does not change field)
null               = empty
whitespace string  = empty after trim for required validation
[]                 = empty for multiple field
0                  = valid numeric value
false              = valid boolean value
```

Field-type normalizers may reject `null` where a specific write contract forbids clearing, but required evaluation must not treat `0` or `false` as empty.

## Defaults

Defaults are static typed values only.

Rules:

- apply only on record creation;
- apply only when the caller did not explicitly provide the field;
- an explicit `null`/empty value is not silently replaced by the default; it is validated as supplied;
- defaults pass the same type/option/reference validation as normal values;
- changing a default does not backfill existing records.

## Reference values

### User reference

- target user identity must exist;
- target must be valid for the current workspace according to membership policy when creating a new reference;
- if later inactive/removed from workspace, preserve the stored historical reference;
- normal selection endpoints exclude inactive targets unless an explicit admin/history mode requests them.

### CRM reference

- definition specifies allowed target entity types;
- referenced target must belong to the same workspace;
- field serialization must not expose a target the caller cannot read;
- if the record is historically referenced but now inaccessible, return an authorized redacted representation or omit the value according to the field/schema response contract—never leak restricted entity details.

### File reference

- file must exist in the shared File service;
- caller must have permission to attach/use it;
- store stable file ID/reference only;
- deleting/retaining the File follows the Files module, not this module.

## Acceptance criteria

- Type handlers reject invalid types with stable field errors.
- Multi-value order is preserved.
- 0 and false satisfy required-field presence.
- Defaults apply only on creation and only when omitted.
- Cross-workspace references are rejected.
- Inactive historical user references remain readable according to permission but cannot be newly selected by default.
- Files are referenced, not copied.
