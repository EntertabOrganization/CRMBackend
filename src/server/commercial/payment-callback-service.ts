import type { PrismaClient,SharedPaymentProviderEvent } from '@prisma/client';
import { createHash } from 'node:crypto';
import { AppError,isAppError } from '../errors';
import { canonical,uuid } from '../process-platform/dto';
import { lock,type Tx } from '../process-platform/context';
import { checkRateLimit } from '../rate-limit';
import { PaymentProviderAuthority } from './payment-provider-authority';
import type { ProviderCommerceEvent } from './payment-providers';

/** Shared Payments owns immutable signature receipts and durable retry/deduplication. */
export class SharedPaymentCallbackService {
  constructor(private readonly db:PrismaClient,readonly providers=new PaymentProviderAuthority()){}
  async bindPayment(tx:Tx,receipt:SharedPaymentProviderEvent,paymentId:string){
    const payment=await tx.commercialPackRecord.findFirst({where:{workspaceId:receipt.workspaceId,id:paymentId,collection:'payments'}}),data=payment?.data as {flow?:string;connectionId?:string;providerKey?:string;providerTransactionId?:string}|undefined;
    if(data?.flow!=='COMMERCE'||data.connectionId!==receipt.connectionId||data.providerKey!==receipt.providerCode||data.providerTransactionId!==(receipt.normalized as {transactionId?:string}).transactionId)
      throw new AppError('PAYMENT_PROVIDER_TRANSACTION_MISMATCH','Receipt does not match its owning Payment.',409);
    const bound=await tx.sharedPaymentProviderEvent.updateMany({where:{id:receipt.id,workspaceId:receipt.workspaceId,status:'QUEUED',OR:[{paymentId:null},{paymentId}]},data:{paymentId}});
    if(bound.count!==1)throw new AppError('PAYMENT_PROVIDER_TRANSACTION_MISMATCH','Receipt mapping is unavailable or changed.',409);
  }
  async receive(providerCode:string,headers:Headers,rawBody:string){
    const denied=()=>new AppError('PAYMENT_PROVIDER_SIGNATURE_INVALID','Payment callback proof is invalid.',401);
    if(providerCode!=='stripe'||headers.has('content-encoding')&&headers.get('content-encoding')!=='identity')throw denied();
    if(Buffer.byteLength(rawBody)>262144)throw new AppError('REQUEST_BODY_TOO_LARGE','Payment event exceeds its limit.',413);
    const id=headers.get('x-payment-connection-id');if(!id||!uuid.safeParse(id).success)throw denied();
    checkRateLimit(id,{scope:'commerce.payment-callback',limit:1200,windowMs:60000});
    const proof=await this.providers.callback(this.db,id),event=proof.verify(headers,rawBody);
    const payloadHash=createHash('sha256').update(canonical(JSON.parse(rawBody))).digest('hex');
    return this.db.$transaction(async tx=>{
      await lock(tx,proof.workspaceId,'commerce:configuration');const current=await this.providers.callback(tx,id);
      if(current.fingerprint!==proof.fingerprint||current.workspaceId!==proof.workspaceId)throw denied();
      const workspace=await tx.workspace.findFirst({where:{id:proof.workspaceId,isDeleted:false}});
      if(!workspace||(workspace.settings as {entitlements?:{commerce?:boolean}}).entitlements?.commerce===false)throw denied();
      await lock(tx,proof.workspaceId,'shared:payment-event:'+id+':'+event.eventId);
      const identity={workspaceId:proof.workspaceId,connectionId:id,providerCode,externalEventId:event.eventId};
      const old=await tx.sharedPaymentProviderEvent.findUnique({where:{workspaceId_connectionId_providerCode_externalEventId:identity}});
      if(old){if(old.payloadHash!==payloadHash)throw new AppError('PAYMENT_DUPLICATE_EVENT','Provider event identity has a different payload.',409);return{eventId:old.id,accepted:true,duplicate:true};}
      const row=await tx.sharedPaymentProviderEvent.create({data:{...identity,payloadHash,normalized:event}});
      await tx.auditLog.create({data:{workspaceId:proof.workspaceId,entityType:'PAYMENT_PROVIDER_EVENT',entityId:row.id,action:'PAYMENT_PROVIDER_EVENT_RECEIVED',metadata:{actorType:'PROVIDER',connectionId:id,providerCode,payloadHash,rawBodyHash:createHash('sha256').update(rawBody).digest('hex')}}});
      return{eventId:row.id,accepted:true,duplicate:false};
    },{timeout:60000});
  }
  async tick(apply:(tx:Tx,row:SharedPaymentProviderEvent,event:ProviderCommerceEvent)=>Promise<'APPLIED'|'IGNORED'|'UNCHANGED'>,limit=20){
    const rows=await this.db.sharedPaymentProviderEvent.findMany({where:{status:'QUEUED',nextAttemptAt:{lte:new Date()}},orderBy:[{receivedAt:'asc'},{id:'asc'}],take:limit});let processed=0;
    for(const candidate of rows)try{
      processed+=await this.db.$transaction(async tx=>{
        await lock(tx,candidate.workspaceId,'commerce:configuration');await lock(tx,candidate.workspaceId,'shared:payment-event:'+candidate.connectionId+':'+candidate.externalEventId);
        const row=await tx.sharedPaymentProviderEvent.findFirst({where:{id:candidate.id,status:'QUEUED',nextAttemptAt:{lte:new Date()}}});if(!row)return 0;
        const outcome=await apply(tx,row,row.normalized as unknown as ProviderCommerceEvent);
        await tx.sharedPaymentProviderEvent.update({where:{id:row.id},data:{status:'SUCCEEDED',outcome,attempts:{increment:1},errorCode:null,processedAt:new Date()}});return 1;
      },{timeout:60000});
    }catch(error){await this.db.$transaction(async tx=>{
      await lock(tx,candidate.workspaceId,'shared:payment-event:'+candidate.connectionId+':'+candidate.externalEventId);
      const row=await tx.sharedPaymentProviderEvent.findFirst({where:{id:candidate.id,status:'QUEUED'}});if(!row)return;
      const attempts=row.attempts+1;await tx.sharedPaymentProviderEvent.update({where:{id:row.id},data:{attempts,status:attempts>=5?'FAILED':'QUEUED',errorCode:isAppError(error)?error.code:'PAYMENT_PROCESSING_FAILED',nextAttemptAt:new Date(Date.now()+Math.min(3600000,1000*2**attempts))}});
    },{timeout:60000});}
    return{processed};
  }
}
