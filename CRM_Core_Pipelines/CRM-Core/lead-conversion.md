# Lead Conversion Specification

## Goal

Implement one explicit, atomic, idempotent Lead conversion command.

## Command

Recommended route:

```text
POST /api/v1/crm/leads/:leadId/convert
```

Requires:

```text
crm.lead.convert
```

and the normal create/link permissions required for target entities under repository policy.

## Conversion choices

```text
Contact: CREATE | LINK_EXISTING | NONE
Company: CREATE | LINK_EXISTING | NONE
Deal:    CREATE | NONE
```

At least Contact or Company must result from conversion.

Deal creation is optional.

## Duplicate behavior

The backend may present duplicate candidates, but never silently selects one.

The client/user explicitly chooses CREATE vs LINK_EXISTING.

Conversion does not perform Data Quality merge.

## Transaction

Perform in one DB transaction:

1. resolve Workspace-scoped Lead
2. validate expected version
3. reject already-converted Lead
4. authorize conversion
5. validate requested existing Contact/Company IDs in same Workspace
6. create/link Contact
7. create/link Company
8. create Deal if requested
9. validate Deal has Company and/or Contacts
10. default Deal amount/currency/source/UTM/origin from Lead when not overridden
11. create `crm_lead_conversions` row with output IDs and actor/time
12. mark Lead converted
13. write AuditLog evidence
14. write compact outbox event
15. commit

## Idempotency

Require/support `Idempotency-Key` under the common 24-hour contract.

Retry of identical successful conversion returns the original result.

Same key with different payload returns `IDEMPOTENCY_KEY_REUSED`.

Independent second conversion attempt without matching idempotent replay returns `CRM_ALREADY_CONVERTED`.

## Post-conversion state

Converted Lead:

- remains stored
- remains visible to authorized history/reporting
- cannot be converted again
- cannot re-enter normal Lead processing through ordinary transition
- keeps original acquisition data and conversion outputs

## Acceptance criteria

- create-only, link-only and mixed conversion work
- Contact-only conversion works
- Company-only conversion works
- Contact + Company + Deal works
- existing customer + new Deal works
- cross-Workspace existing IDs fail without leakage
- transaction rollback leaves no partial entities
- idempotent retry never duplicates outputs
