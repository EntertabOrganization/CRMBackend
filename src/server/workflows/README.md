# Workflow implementation checkpoint

The execution discussion API resolves a shared Timeline reference:

`GET /api/v1/workflow-executions/:executionId/discussion`

The reference points to `/api/v1/crm/WORKFLOW_EXECUTION/:executionId/timeline`.
Comments use the existing Timeline comment create/read/edit/delete handlers and
the existing comment, mention, audit, outbox and idempotency records. Workflow
does not keep a second comment store. Resolving or reading a discussion does not
create records or expose execution variables.

Every operation resolves current active Workspace membership and explicit
Workflow execution-view permission, then checks the bound source through its
owning authority. Timeline grants and their owner/department scopes also apply;
owner roles do not bypass these dedicated checks. Mention events indicate
whether the recipient currently has both execution and Timeline visibility.
Mentioning someone does not grant access.

Comments, shared idempotency, audit and outbox commit in one database transaction
under a per-thread lock. Edits require `expectedVersion`. Deletion is soft and
execution Legal Hold prevents deletion in both the service and database guard.
The additive `202610130005_workflow_shared_discussion` migration has only been
deployed to the disposable focused test database.

`tests/workflow-discussion.spec.ts` exercises this changed slice with real
PostgreSQL fixtures, authenticated Next handlers and temporary Nest startup.
The broader Workflow module remains in progress: additional owner action
adapters, provider compensation, governance/recovery details and frontend work
are still required. See the root implementation progress record.
