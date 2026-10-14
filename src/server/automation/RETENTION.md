# Automation diagnostic retention

Schedule `POST /api/v1/internal/crm/jobs/automation-diagnostic-retention` with the existing `X-Internal-Job-Token`. The strict JSON body is `{ "workspaceId": "<uuid>", "limit": 500 }`; limit accepts 1–5000. This is a trusted scheduler operation; employee sessions do not authorize it. Run separately for each Workspace and repeat while `hasMore` is true.

Workspace `settings.automationDiagnosticRetentionDays` controls the verbose diagnostic log window (default 90 days, valid range 1–3650 whole days). Invalid configuration fails without deleting anything. Age uses log creation time with a strict cutoff. Logs for pending/running jobs, pending/running/retryable-failed executions, or missing referenced checkpoints remain available for recovery. An active recovery Job protects execution diagnostics even before the execution state advances.

The shared platform's `retentionRecords` block pruning while their retention date is in the future or legal hold is active. Records can protect a Workspace, log, Rule, revision, execution, Job, target or source event. The worker takes the same Workspace revision lock as shared retention changes, serializes competing retention batches, and deletes a bounded oldest-first set in one transaction with safe Audit/outbox totals. Retries do not duplicate a deletion or completion event.

This operation prunes only `automation_logs`. It preserves execution summaries and unique start identities, action results/attempts and effect idempotency keys, Jobs, immutable published Rule revisions, configuration history, source/outbox events and all existing central Audit. It cannot make completed actions replay. Wider business-history archival has a separate lifecycle.

Deploy `202610140003_automation_diagnostic_retention` before scheduling the worker. Validation uses only disposable databases; application migration and production scheduler execution are deployment operations.
