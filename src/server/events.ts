import type { OutboxEvent } from './domain';
import type { InMemoryStore } from './store';

export type DomainEventInput = {
  workspaceId: string;
  eventType: string;
  /** Aggregate the event is about, e.g. ACTIVITY, LEAD, CUSTOM_FIELD. */
  entityType: string;
  entityId: string;
  actorUserId?: string | null;
  /** Safe, compact change summary. Never a full business record. */
  changes?: Record<string, unknown>;
  occurredAt?: Date;
  eventVersion?: number;
  correlationId?: string | null;
  causationId?: string | null;
  idempotencyKey?: string | null;
};

/**
 * Writes an event to the transactional outbox. The row is part of the same in-memory state that the request
 * wrapper persists in ONE database transaction, so domain state and its event commit (or roll back) together.
 */
export function emitDomainEvent(store: InMemoryStore, input: DomainEventInput): OutboxEvent {
  const event: OutboxEvent = {
    id: store.id(),
    workspaceId: input.workspaceId,
    eventType: input.eventType,
    entityType: input.entityType,
    entityId: input.entityId,
    actorUserId: input.actorUserId ?? null,
    occurredAt: input.occurredAt ?? new Date(),
    payload: input.changes ?? {},
    eventVersion: input.eventVersion ?? 1,
    correlationId: input.correlationId ?? null,
    causationId: input.causationId ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
    projectedAt: null,
  };
  store.state.outboxEvents.push(event);
  return event;
}

/** The stable envelope described by the platform contract, derived from an outbox row. */
export function toEventEnvelope(event: OutboxEvent) {
  return {
    eventId: event.id,
    eventType: event.eventType,
    eventVersion: event.eventVersion ?? 1,
    workspaceId: event.workspaceId,
    aggregateType: event.entityType,
    aggregateId: event.entityId,
    actor: event.actorUserId ? { type: 'USER' as const, userId: event.actorUserId } : { type: 'SYSTEM' as const },
    occurredAt: event.occurredAt.toISOString(),
    correlationId: event.correlationId ?? null,
    causationId: event.causationId ?? null,
    idempotencyKey: event.idempotencyKey ?? null,
    changes: event.payload,
  };
}
