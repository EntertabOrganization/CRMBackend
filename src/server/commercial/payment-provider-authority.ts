import { z } from 'zod';
import { createHash } from 'node:crypto';
import { AppError } from '../errors';
import { EnvironmentSecretPort } from '../integration-connections';
import type { SecretPort } from '../ports';
import { parse,uuid } from '../process-platform/dto';
import { requirePermission,type Principal,type Tx } from '../process-platform/context';
import { ownerVisible } from '../process-platform/owner-scope';
import { StripePaymentAdapter,type PaymentProviderAdapter } from './payment-providers';

export const paymentMethodDto=z.strictObject({ id:uuid,provider:z.literal('stripe'),connectionId:uuid,
  modes:z.array(z.enum(['SALE','AUTHORIZE'])).min(1).max(2).refine(v=>new Set(v).size===v.length),multicapture:z.boolean().default(false) });
export const paymentMethodsDto=z.array(paymentMethodDto).max(20).refine(v=>new Set(v.map(m=>m.id)).size===v.length);
export type PaymentMethod=z.infer<typeof paymentMethodDto>;
const credentialDto=z.strictObject({ apiKey:z.string().min(16).max(500),webhookSecret:z.string().min(16).max(500),merchantId:z.string().min(1).max(160) });
type Credential=z.infer<typeof credentialDto>;
/** Fixed provider endpoints; tenant credential bundles resolve only through the shared SecretPort. */
export class PaymentProviderAuthority {
  constructor(private readonly secrets:SecretPort=new EnvironmentSecretPort(),private readonly factory=(method:PaymentMethod,credential:Credential):PaymentProviderAdapter=>new StripePaymentAdapter(credential.apiKey,credential.webhookSecret,credential.merchantId,method.multicapture)){}
  async resolve(tx:Tx,actor:Principal,method:PaymentMethod){
    requirePermission(actor,'INTEGRATION.CONNECTION_USE');
    const row=await tx.integrationOutboundConnection.findFirst({where:{workspaceId:actor.workspaceId,id:method.connectionId,isActive:true}});
    if(!row||!row.secretReference||!row.supportsIdempotency||!await ownerVisible(tx,actor,row.createdByUserId,'INTEGRATION.CONNECTION_USE'))throw new AppError('PAYMENT_PROVIDER_NOT_CONFIGURED','Payment connection is unavailable.',409);
    let origin:string;try{origin=new URL(row.baseUrl).origin;}catch{throw new AppError('PAYMENT_PROVIDER_NOT_CONFIGURED','Payment connection has an invalid provider binding.',409);}
    if(origin!=='https://api.stripe.com'||!Array.isArray(row.allowedHosts)||!row.allowedHosts.includes('api.stripe.com'))throw new AppError('PAYMENT_PROVIDER_NOT_CONFIGURED','Payment connection has an invalid provider binding.',409);
    const secret=this.secrets.resolve(actor.workspaceId,row.secretReference);let raw:unknown;
    try{raw=JSON.parse(secret??'');}catch{throw new AppError('PAYMENT_PROVIDER_NOT_CONFIGURED','Payment credential is unavailable.',503);}
    const result=credentialDto.safeParse(raw);if(!result.success)throw new AppError('PAYMENT_PROVIDER_NOT_CONFIGURED','Payment credential is unavailable.',503);
    const adapter=this.factory(method,result.data);
    if(adapter.key()!==method.provider||adapter.merchantIdentity()!==result.data.merchantId)throw new AppError('PAYMENT_PROVIDER_NOT_CONFIGURED','Payment adapter identity is invalid.',409);
    return{adapter,connectionId:row.id,merchantId:result.data.merchantId};
  }
  methods(settings:unknown){const row=settings as {providerPaymentMethods?:unknown};return parse(paymentMethodsDto,row.providerPaymentMethods??[]);}
  async callback(tx:Tx,connectionId:string){
    const row=await tx.integrationOutboundConnection.findFirst({where:{id:connectionId,isActive:true,supportsIdempotency:true}});
    if(!row?.secretReference)throw new AppError('PAYMENT_PROVIDER_SIGNATURE_INVALID','Payment connection proof is unavailable.',401);
    const secret=this.secrets.resolve(row.workspaceId,row.secretReference);let raw:unknown;try{raw=JSON.parse(secret??'');}catch{throw new AppError('PAYMENT_PROVIDER_SIGNATURE_INVALID','Payment connection proof is unavailable.',401);}
    const parsed=credentialDto.safeParse(raw);if(!parsed.success)throw new AppError('PAYMENT_PROVIDER_SIGNATURE_INVALID','Payment connection proof is unavailable.',401);
    const adapter=new StripePaymentAdapter(parsed.data.apiKey,parsed.data.webhookSecret,parsed.data.merchantId);
    return{workspaceId:row.workspaceId,connectionId:row.id,merchantId:parsed.data.merchantId,fingerprint:createHash('sha256').update(secret!).digest('hex'),verify:(headers:Headers,body:string)=>adapter.verifyCommerceWebhook(headers,body)};
  }
}
