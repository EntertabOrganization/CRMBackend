import type { AuditLog } from './domain';
import { forbidden, notFound } from './errors';
import { sanitizeAuditPayload } from './sanitize';
import type { InMemoryStore } from './store';

type AuditInput = Omit<AuditLog, 'id' | 'occurredAt' | 'beforeData' | 'afterData' | 'metadata'> & {
  beforeData?: unknown;
  afterData?: unknown;
  metadata?: unknown;
};

export class AuditService {
  constructor(private readonly store: InMemoryStore) {}

  write(input: AuditInput) {
    const log: AuditLog = {
      ...input,
      id: this.store.id(),
      beforeData: sanitizeAuditPayload(input.beforeData),
      afterData: sanitizeAuditPayload(input.afterData),
      metadata: sanitizeAuditPayload(input.metadata),
      occurredAt: new Date(),
    };
    this.store.state.auditLogs.push(log);
    return log;
  }

  list(workspaceId: string | null, isOwner = false) {
    if (!isOwner) throw forbidden('audit.read permission is required.');
    return this.store.state.auditLogs.filter((log) => !workspaceId || log.workspaceId === workspaceId);
  }

  get(id: string, workspaceId: string | null, isOwner = false) {
    const log = this.list(workspaceId, isOwner).find((item) => item.id === id);
    if (!log) throw notFound('Audit log');
    return log;
  }
}
