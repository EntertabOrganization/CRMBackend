# Automation Logs & Observability

## Execution log vs Audit

Execution log answers: **what did the automation engine do?**

Audit answers: **who changed configuration or issued sensitive commands?**

Keep them separate.

## Execution log requirements

For each execution capture safe metadata:

- Rule ID/name and revision;
- target type/ID/title snapshot where safe;
- source event/Trigger;
- timing mode;
- initiating actor;
- execution identity;
- correlation/causation/depth;
- condition outcome summary;
- Action results;
- attempts;
- timestamps/duration;
- final status;
- stable error code;
- redacted diagnostic details.

Do not persist secrets or entire provider payloads unless explicitly required and retention-approved.

## Operational metrics

Expose metrics through the platform observability layer:

- matched Rules count;
- executions started/succeeded/failed/skipped;
- job queue delay;
- retry count;
- dead-letter/final failure count;
- average/p95 execution duration;
- Action type/provider failure rate;
- loop-limit activations.

Include Workspace labels only where safe for internal metrics and avoid high-cardinality raw IDs in metrics systems if prohibited by platform conventions.

## Supportability

Correlation ID must let support trace:

```text
source domain event
 -> Automation execution
 -> individual Action attempts
 -> resulting domain event/provider request
```

## Retention

Execution logs use platform retention policy. Configuration/revision history and critical Audit may require longer retention than verbose per-attempt diagnostics.

## Acceptance criteria

- A failed Action can be diagnosed without database access.
- Secrets are redacted.
- Queue lag/failure can be monitored.
- Correlation connects Automation to resulting domain mutation.
