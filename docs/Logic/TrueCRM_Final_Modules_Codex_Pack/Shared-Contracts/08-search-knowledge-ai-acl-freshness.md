# Search and AI access invariants

Search index and AI chunks are derived, not security authority. Knowledge article ACL may narrow Space ACL, article File reference additionally requires File permission. Retrieval pipeline:

1. Authenticated request -> workspace/scenario entitlement + user module permission.
2. Resolve source documents allowed by Space+Article+File ACL and classification; published and AI-approved only.
3. Obtain candidate snippets/chunks from FTS/vector read model.
4. Re-evaluate **live authorization** and current published revision for each result *after* candidate selection and *before* returning content to LLM; remove stale results.
5. Return stable citeable `(sourceType,sourceId,version,anchor)` references; citation hyperlink requires authorization again when clicked.
6. On revoke/archive/delete/index-policy-off bump ACL/index versions, cancel pending retrievals as necessary, tombstone stale chunks and enqueue eventual projection cleanup.

Search count/snippets/autocomplete and notifications must not leak titles, filenames or private metadata. Public guest Knowledge invitations are per article/space scope and do not grant global Workspace/AI access. AI role/assistants cannot ask a forbidden broad source query to escalate. Include adversarial cross-tenant, stale index, prompt-injection and revoked file cases.
