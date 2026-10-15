import type { PrismaClient,SharedPaymentCommand } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors';
import { exact } from '../inventory/decimal';
import { decimal,parse,uuid } from '../process-platform/dto';
import { lock,requirePermission,resolvePrincipal,type Principal,type Tx } from '../process-platform/context';
import { SharedPaymentCommandService,paymentCommandAck,paymentCommandPermission } from '../commercial/payment-command-service';
import { PaymentProviderAuthority } from '../commercial/payment-provider-authority';
import { CommerceOrderService } from './order-service';

const createDto=z.strictObject({methodId:uuid,amount:decimal,mode:z.enum(['SALE','AUTHORIZE'])});
const captureDto=z.strictObject({amount:decimal});
const voidDto=z.strictObject({reason:z.string().trim().min(1).max(2000)});
const commercePermission=(kind:string)=>kind==='CAPTURE'?'COMMERCE.PAYMENT_CAPTURE':'COMMERCE.PAYMENT_MANAGE';
export class CommercePaymentCommandService {
  readonly shared:SharedPaymentCommandService;
  constructor(private readonly db:PrismaClient,readonly orders=new CommerceOrderService(db),readonly providers=new PaymentProviderAuthority()){this.shared=new SharedPaymentCommandService(db);}
  private async method(tx:Tx,actor:Principal,storeId:string,methodId:string,permission:string){
    const store=await this.orders.stores.store(tx,actor,storeId,permission);
    const method=this.providers.methods(store.settings).find(m=>m.id===methodId);
    if(!method)throw new AppError('PAYMENT_PROVIDER_NOT_CONFIGURED','Payment method is unavailable.',409);
    return{store,method,...await this.providers.resolve(tx,actor,method)};
  }
  async create(actor:Principal,orderId:string,raw:unknown,key:string|null){
    parse(uuid,orderId);const input=parse(createDto,raw),identity=this.shared.identity('CREATE:'+orderId,key,input);
    return this.db.$transaction(async tx=>{
      await lock(tx,actor.workspaceId,'commerce:configuration');await lock(tx,actor.workspaceId,'commerce:order:'+orderId);
      actor=await resolvePrincipal(tx,actor.workspaceId,actor.userId);const order=await this.orders.load(tx,actor,orderId,'COMMERCE.PAYMENT_MANAGE');requirePermission(actor,'payment.create_attempt');
      const old=await this.shared.replay(tx,actor,identity);if(old)return paymentCommandAck(old);
      if(order.archivedAt||['CANCELLED','COMPLETED'].includes(order.status))throw new AppError('PAYMENT_INVALID_STATE','Order cannot accept a new payment.',409);
      const config=await this.method(tx,actor,order.storeId,input.methodId,'COMMERCE.PAYMENT_MANAGE');
      if(config.store.status!=='ACTIVE'||!config.method.modes.includes(input.mode)||input.mode==='AUTHORIZE'&&!config.adapter.capabilities().authorization)throw new AppError('PAYMENT_INVALID_STATE','Payment mode is unavailable.',409);
      const bindings=await tx.commerceOrderPaymentBinding.findMany({where:{workspaceId:actor.workspaceId,orderId}});let committed=exact(0);
      for(const binding of bindings){
        const row=await tx.commercialPackRecord.findFirst({where:{workspaceId:actor.workspaceId,id:binding.paymentId,collection:'payments'}});
        if(!row)throw new AppError('PAYMENT_INVALID_STATE','Payment ledger requires reconciliation.',409);
        const state=row.data as {financialState?:string;settlementStatus?:string;authorizedAmount?:string};
        if(!['FAILED','VOIDED'].includes(state.financialState??'')&&!['FAILED','CANCELLED'].includes(state.settlementStatus??''))committed=committed.plus(state.financialState==='PARTIALLY_CAPTURED'?state.authorizedAmount??binding.requestedAmount??binding.amount:binding.requestedAmount??binding.amount);
      }
      if(exact(input.amount).lte(0)||committed.plus(input.amount).gt(order.total))throw new AppError('PAYMENT_AMOUNT_INVALID','Payment exceeds the Order remaining amount.',409);
      const row=await this.shared.create(tx,actor,{amount:input.amount,currency:order.currency,mode:input.mode,sourceOrderId:orderId},identity,{methodId:input.methodId,connectionId:config.connectionId,providerKey:config.method.provider,merchantId:config.merchantId});
      await tx.commerceOrderPaymentBinding.create({data:{workspaceId:actor.workspaceId,storeId:order.storeId,orderId,paymentId:row.paymentId,amount:'0',requestedAmount:input.amount}});
      return paymentCommandAck(row);
    },{timeout:60000});
  }
  async change(actor:Principal,paymentId:string,kind:'CAPTURE'|'VOID',raw:unknown,key:string|null){
    parse(uuid,paymentId);kind==='CAPTURE'?parse(captureDto,raw):parse(voidDto,raw);
    return this.db.$transaction(tx=>this.changeInTransaction(tx,actor,paymentId,kind,raw,key),{timeout:60000});
  }
  /** Owning command entry point for callers (e.g. Workflow adapters) that already hold a transaction. */
  async changeInTransaction(tx:Tx,actor:Principal,paymentId:string,kind:'CAPTURE'|'VOID',raw:unknown,key:string|null){
    parse(uuid,paymentId);const input=kind==='CAPTURE'?parse(captureDto,raw):parse(voidDto,raw),identity=this.shared.identity(kind+':'+paymentId,key,input);
    {
      await lock(tx,actor.workspaceId,'commerce:configuration');
      const binding=await tx.commerceOrderPaymentBinding.findFirst({where:{workspaceId:actor.workspaceId,paymentId}});
      if(!binding)throw new AppError('PAYMENT_NOT_FOUND','Payment was not found.',404);
      await lock(tx,actor.workspaceId,'commerce:order:'+binding.orderId);await lock(tx,actor.workspaceId,'shared:payment:'+paymentId);
      actor=await resolvePrincipal(tx,actor.workspaceId,actor.userId);const order=await this.orders.load(tx,actor,binding.orderId,commercePermission(kind));
      const payment=await this.shared.load(tx,actor,paymentId,paymentCommandPermission(kind)),old=await this.shared.replay(tx,actor,identity);if(old)return paymentCommandAck(old);
      if(payment.sourceOrderId!==order.id||payment.currencyCode!==order.currency)throw new AppError('PAYMENT_CURRENCY_MISMATCH','Order payment binding requires reconciliation.',409);
      if(order.archivedAt||order.status==='CANCELLED')throw new AppError('PAYMENT_INVALID_STATE','Order cannot accept this payment command.',409);
      const config=await this.method(tx,actor,order.storeId,payment.methodId,commercePermission(kind));
      if(config.connectionId!==payment.connectionId||config.merchantId!==payment.merchantId||config.method.provider!==payment.providerKey||!config.adapter.capabilities()[kind==='CAPTURE'?'capture':'void'])throw new AppError('PAYMENT_PROVIDER_NOT_CONFIGURED','Payment method binding changed or lacks this capability.',409);
      return paymentCommandAck(await this.shared.change(tx,actor,payment,kind,input,identity,{methodId:payment.methodId,connectionId:config.connectionId,providerKey:payment.providerKey,merchantId:payment.merchantId},Boolean(config.adapter.capabilities().multicapture)));
    }
  }
  private async authorize(tx:Tx,row:SharedPaymentCommand){
    await lock(tx,row.workspaceId,'commerce:configuration');
    const binding=await tx.commerceOrderPaymentBinding.findFirst({where:{workspaceId:row.workspaceId,paymentId:row.paymentId}});
    if(!binding)throw new AppError('PAYMENT_NOT_FOUND','Payment Order binding is unavailable.',404);
    await lock(tx,row.workspaceId,'commerce:order:'+binding.orderId);
    const actor=await resolvePrincipal(tx,row.workspaceId,row.actorUserId),order=await this.orders.load(tx,actor,binding.orderId,commercePermission(row.kind));
    if(order.archivedAt||order.status==='CANCELLED')throw new AppError('PAYMENT_INVALID_STATE','Order is unavailable for provider processing.',409);
    const config=await this.method(tx,actor,order.storeId,row.methodId,commercePermission(row.kind));requirePermission(actor,paymentCommandPermission(row.kind));
    if(config.store.status!=='ACTIVE'||config.connectionId!==row.connectionId||config.method.provider!==row.providerKey||config.merchantId!==row.merchantId||['SALE','AUTHORIZE'].includes(row.kind)&&!config.method.modes.includes(row.kind as 'SALE'|'AUTHORIZE'))throw new AppError('PAYMENT_PROVIDER_NOT_CONFIGURED','Provider command binding is no longer valid.',409);
    if(row.kind==='AUTHORIZE'&&!config.adapter.capabilities().authorization||row.kind==='CAPTURE'&&!config.adapter.capture||row.kind==='VOID'&&!config.adapter.void)throw new AppError('PAYMENT_PROVIDER_STATE_UNSUPPORTED','Provider capability is unavailable.',422);
    return{actor,adapter:config.adapter};
  }
  process(commandId:string){return this.shared.process(commandId,(tx,row)=>this.authorize(tx,row));}
  async tick(limit=20){
    const now=new Date(),rows=await this.db.sharedPaymentCommand.findMany({where:{OR:[{status:'QUEUED',nextAttemptAt:{lte:now}},{status:'RUNNING',leaseExpiresAt:{lte:now}}]},orderBy:[{createdAt:'asc'},{id:'asc'}],take:limit});
    let processed=0;for(const row of rows)if(await this.process(row.id))processed++;return{scanned:rows.length,processed};
  }
}
