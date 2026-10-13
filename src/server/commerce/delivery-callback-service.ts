import { type PrismaClient } from '@prisma/client';
import { createHash,createHmac,timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError,isAppError } from '../errors';
import { canonical,parse,uuid } from '../process-platform/dto';
import { lock,resolvePrincipal } from '../process-platform/context';
import { checkRateLimit } from '../rate-limit';
import { EnvironmentSecretPort } from '../integration-connections';
import type { SecretPort } from '../ports';
import { CommerceShipmentService } from './shipment-service';

export const normalizedDeliveryEvent = z.strictObject({ eventId: z.string().min(1).max(160),externalShipmentId: z.string().min(1).max(160),
  status: z.enum(['IN_TRANSIT','DELIVERED','FAILED','RETURNED']),providerStatus: z.string().min(1).max(100),occurredAt: z.iso.datetime({ offset: true }) });
type DeliveryEvent = z.infer<typeof normalizedDeliveryEvent>;
export interface DeliveryCallbackAdapter {
  code: string;
  verify(headers: Headers,rawBody: string,secret: string): DeliveryEvent;
}
const denied = () => new AppError('DELIVERY_PROVIDER_SIGNATURE_INVALID','Delivery callback proof is invalid.',401);
export class HmacDeliveryCallbackAdapter implements DeliveryCallbackAdapter {
  readonly code = 'generic-hmac';
  verify(headers: Headers,rawBody: string,secret: string) {
    const timestamp = headers.get('x-delivery-timestamp'),signature = headers.get('x-delivery-signature') ?? '';
    if (!timestamp || !/^\d{10}$/.test(timestamp) || Math.abs(Date.now()/1000-Number(timestamp))>300 || !/^[a-f0-9]{64}$/.test(signature)) throw denied();
    const expected = createHmac('sha256',secret).update(timestamp+'.'+rawBody).digest('hex');
    if (!timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(expected,'hex'))) throw denied();
    let body: unknown; try { body = JSON.parse(rawBody); } catch { throw new AppError('INVALID_JSON','Delivery event must be JSON.',400); }
    return parse(normalizedDeliveryEvent,body);
  }
}

/** Durable inbox; provider credentials and current worker authority remain with their owning platform. */
export class CommerceDeliveryCallbackService {
  private readonly adapters = new Map<string,DeliveryCallbackAdapter>();
  constructor(private readonly db: PrismaClient,readonly shipments = new CommerceShipmentService(db),private readonly secrets: SecretPort = new EnvironmentSecretPort()) { this.register(new HmacDeliveryCallbackAdapter()); }
  register(adapter: DeliveryCallbackAdapter) { this.adapters.set(adapter.code,adapter); return this; }
  async receive(providerCode: string,headers: Headers,rawBody: string) {
    const adapter = this.adapters.get(providerCode);
    if (!adapter) throw denied();
    checkRateLimit(providerCode,{ scope: 'commerce.delivery-callback',limit: 1200,windowMs: 60000 });
    if (Buffer.byteLength(rawBody)>262144) throw new AppError('REQUEST_BODY_TOO_LARGE','Delivery event exceeds its limit.',413);
    if (headers.has('content-encoding') && headers.get('content-encoding')!=='identity') throw denied();
    const connectionId = headers.get('x-delivery-connection-id');
    if (!connectionId || !uuid.safeParse(connectionId).success) throw denied();
    const connection = await this.db.integrationOutboundConnection.findUnique({ where: { id: connectionId } });
    if (!connection?.isActive || !connection.secretReference) throw denied();
    const secret = this.secrets.resolve(connection.workspaceId,connection.secretReference);
    if (!secret || secret.length<32) throw denied();
    const event = adapter.verify(headers,rawBody,secret);
    if (new Date(event.occurredAt)>new Date()) throw new AppError('SHIPMENT_INVALID_STATE','Provider event timestamp cannot be in the future.',422);
    const payloadHash = createHash('sha256').update(canonical(event)).digest('hex');
    return this.db.$transaction(async tx => {
      await lock(tx,connection.workspaceId,'commerce:configuration');
      const current = await tx.integrationOutboundConnection.findFirst({ where: { id: connection.id,workspaceId: connection.workspaceId,isActive: true } });
      if (!current?.secretReference || this.secrets.resolve(current.workspaceId,current.secretReference)!==secret) throw denied();
      await lock(tx,connection.workspaceId,'commerce:delivery:'+connection.id+':'+event.eventId);
      const identity = { workspaceId: connection.workspaceId,connectionId: connection.id,providerCode,externalEventId: event.eventId };
      const prior = await tx.commerceDeliveryProviderEvent.findUnique({ where: { workspaceId_connectionId_providerCode_externalEventId: identity } });
      if (prior) {
        if (prior.payloadHash!==payloadHash) throw new AppError('DELIVERY_PROVIDER_REPLAY_CONFLICT','Event ID was used with another payload.',409);
        return { eventId: prior.id,accepted: true,duplicate: true };
      }
      const services = await tx.commerceDeliveryService.findMany({ where: { workspaceId: connection.workspaceId,providerConnectionId: connection.id,active: true },select: { id: true } });
      const rows = await tx.commerceShipment.findMany({ where: { workspaceId: connection.workspaceId,externalShipmentId: event.externalShipmentId,deliveryServiceId: { in: services.map(s => s.id) } } });
      if (rows.length!==1) throw denied();
      const shipment = rows[0],workspace = await tx.workspace.findFirst({ where: { id: connection.workspaceId,isDeleted: false } });
      if (!workspace || (workspace.settings as { entitlements?: { commerce?: boolean } }).entitlements?.commerce===false) throw denied();
      const row = await tx.commerceDeliveryProviderEvent.create({ data: { ...identity,storeId: shipment.storeId,shipmentId: shipment.id,payloadHash,normalized: event } });
      await tx.auditLog.create({ data: { workspaceId: row.workspaceId,entityType: 'COMMERCE_DELIVERY_EVENT',entityId: row.id,action: 'DELIVERY_PROVIDER_EVENT_RECEIVED',metadata: { actorType: 'PROVIDER',providerCode,connectionId: connection.id,payloadHash,rawBodyHash: createHash('sha256').update(rawBody).digest('hex') } } });
      return { eventId: row.id,accepted: true,duplicate: false };
    },{ timeout: 60000 });
  }
  async tick(limit = 20) {
    const due = await this.db.commerceDeliveryProviderEvent.findMany({ where: { status: 'QUEUED',nextAttemptAt: { lte: new Date() } },orderBy: [{ receivedAt: 'asc' },{ id: 'asc' }],take: limit });
    let processed = 0;
    for (const candidate of due) {
      try {
        processed += await this.db.$transaction(async tx => {
          await lock(tx,candidate.workspaceId,'commerce:configuration'); await lock(tx,candidate.workspaceId,'commerce:delivery:'+candidate.connectionId+':'+candidate.externalEventId);
          const row = await tx.commerceDeliveryProviderEvent.findFirst({ where: { id: candidate.id,workspaceId: candidate.workspaceId,status: 'QUEUED',nextAttemptAt: { lte: new Date() } } });
          if (!row) return 0;
          const connection = await tx.integrationOutboundConnection.findFirst({ where: { workspaceId: row.workspaceId,id: row.connectionId,isActive: true } });
          const store = await tx.commerceStore.findFirstOrThrow({ where: { workspaceId: row.workspaceId,id: row.storeId } });
          const userId = (store.settings as { deliveryPrincipalUserId?: string }).deliveryPrincipalUserId;
          if (!connection || !userId) throw new AppError('DELIVERY_AUTHORITY_UNAVAILABLE','Delivery connection or service principal is unavailable.',403);
          const shipment = await tx.commerceShipment.findFirstOrThrow({ where: { workspaceId: row.workspaceId,id: row.shipmentId } });
          const service = await tx.commerceDeliveryService.findFirst({ where: { workspaceId: row.workspaceId,storeId: row.storeId,providerConnectionId: row.connectionId,active: true,id: shipment.deliveryServiceId } });
          if (!service) throw new AppError('DELIVERY_AUTHORITY_UNAVAILABLE','Delivery binding is no longer available.',403);
          const actor = await resolvePrincipal(tx,row.workspaceId,userId),event = parse(normalizedDeliveryEvent,row.normalized);
          if (shipment.externalShipmentId!==event.externalShipmentId) throw new AppError('DELIVERY_AUTHORITY_UNAVAILABLE','External shipment binding changed after receipt.',403);
          await this.shipments.applyDeliveryEvent(tx,actor,row.shipmentId,{ status: event.status,occurredAt: event.occurredAt,providerStatus: event.providerStatus,externalEventId: event.eventId });
          await tx.commerceDeliveryProviderEvent.update({ where: { id: row.id },data: { status: 'SUCCEEDED',attempts: { increment: 1 },processedAt: new Date(),errorCode: null } }); return 1;
        },{ timeout: 60000 });
      } catch (error) {
        await this.db.$transaction(async tx => {
          await lock(tx,candidate.workspaceId,'commerce:configuration'); await lock(tx,candidate.workspaceId,'commerce:delivery:'+candidate.connectionId+':'+candidate.externalEventId);
          const row = await tx.commerceDeliveryProviderEvent.findFirst({ where: { id: candidate.id,workspaceId: candidate.workspaceId,status: 'QUEUED' } });
          if (!row) return;
          const attempts = row.attempts+1;
          await tx.commerceDeliveryProviderEvent.update({ where: { id: row.id },data: { attempts,status: attempts>=5 ? 'FAILED' : 'QUEUED',errorCode: isAppError(error) ? error.code : 'DELIVERY_PROCESSING_FAILED',nextAttemptAt: new Date(Date.now()+Math.min(3600000,1000*2**attempts)) } });
        },{ timeout: 60000 });
      }
    }
    return { processed };
  }
}
