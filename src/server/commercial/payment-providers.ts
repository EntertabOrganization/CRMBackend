import { createHmac, timingSafeEqual } from 'crypto';
import { AppError } from '../errors';
import { z } from 'zod';
import { parse } from '../process-platform/dto';

export type ProviderAttemptInput = { amount:string; currencyCode:string; idempotencyKey:string; mode?:'SALE'|'AUTHORIZE' };
export type ProviderAttemptResult = { transactionId:string; checkoutUrl?:string; publicData?:Record<string,unknown> };
export type ProviderPaymentState = { transactionId:string; status:'PENDING'|'SUCCEEDED'|'FAILED'; amount:string; currencyCode:string; merchantId:string };
export type VerifiedProviderEvent = ProviderPaymentState & { eventId:string; eventType:'PAYMENT_SUCCEEDED'|'PAYMENT_FAILED'|'REFUND_SUCCEEDED'|'REFUND_FAILED'; refundId?:string };
export type ProviderLifecycleState = { transactionId:string;status:'PENDING'|'AUTHORIZED'|'PARTIALLY_CAPTURED'|'PAID'|'VOIDED'|'FAILED';amount:string;authorizedAmount:string;capturedAmount:string;currencyCode:string;merchantId:string };
export type ProviderLifecycleEvent=ProviderLifecycleState&{eventId:string;occurredAt:string;failed:boolean;operationKey?:string};
export type ProviderDisputeEvent={kind:'DISPUTE';eventId:string;occurredAt:string;transactionId:string;merchantId:string;disputeId:string;chargeId:string;amount:string;currencyCode:string;providerStatus:string;status:'OPEN'|'EVIDENCE_REQUIRED'|'SUBMITTED'|'WON'|'LOST';openedAt:string;reason:string;evidence:{hasEvidence:boolean;pastDue:boolean;submissionCount:number;dueAt:string|null}};
export type ProviderRefundEvent={kind:'REFUND';eventId:string;occurredAt:string;transactionId:string;merchantId:string;refundId:string;amount:string;currencyCode:string;status:'PENDING'|'SUCCEEDED'|'FAILED'|'CANCELLED';operationKey?:string;refundReference?:string};
export type ProviderCommerceEvent=ProviderLifecycleEvent|ProviderDisputeEvent|ProviderRefundEvent;
export type ProviderRefundInput={transactionId:string;amount:string;currencyCode:string;idempotencyKey:string;refundReference?:string};
export type ProviderCaptureInput = { transactionId:string;amount:string;currencyCode:string;idempotencyKey:string };
export type ProviderVoidInput = { transactionId:string;idempotencyKey:string };
export interface PaymentProviderAdapter {
  key():string; merchantIdentity():string; createPaymentAttempt(input:ProviderAttemptInput):Promise<ProviderAttemptResult>; retrievePayment(transactionId:string):Promise<ProviderPaymentState>;
  verifyAndParseWebhook(headers:Record<string,string>,rawBody:string):Promise<VerifiedProviderEvent>; refund(input:ProviderRefundInput):Promise<{refundId:string;status:'PENDING'|'SUCCEEDED'|'FAILED'}>;
  retrieveLifecycle?(transactionId:string):Promise<ProviderLifecycleState>;
  capture?(input:ProviderCaptureInput):Promise<ProviderLifecycleState>;
  void?(input:ProviderVoidInput):Promise<ProviderLifecycleState>;
  capabilities():{webhookSignatures:boolean;refunds:boolean;authoritativeLookup:boolean;authorization?:boolean;capture?:boolean;void?:boolean;multicapture?:boolean};
}

export class DeterministicPaymentAdapter implements PaymentProviderAdapter {
  readonly states = new Map<string,ProviderPaymentState>();
  constructor(private readonly providerKey:string, private readonly secret:string, private readonly merchantId:string, private readonly lookupFallback=false) {}
  key(){return this.providerKey;}
  merchantIdentity(){return this.merchantId;}
  async createPaymentAttempt(input:ProviderAttemptInput){const transactionId=`${this.providerKey}_${input.idempotencyKey}`;this.states.set(transactionId,{transactionId,status:'PENDING',amount:input.amount,currencyCode:input.currencyCode,merchantId:this.merchantId});return{transactionId,checkoutUrl:`https://checkout.invalid/${this.providerKey}/${transactionId}`};}
  async retrievePayment(transactionId:string){const state=this.states.get(transactionId);if(!state)throw new AppError('PAYMENT_PROVIDER_TRANSACTION_MISMATCH','Provider transaction was not found.',409);return structuredClone(state);}
  settle(transactionId:string,status:'SUCCEEDED'|'FAILED'){const state=this.states.get(transactionId);if(!state)throw new Error('Unknown transaction');state.status=status;}
  sign(rawBody:string){return createHmac('sha256',this.secret).update(rawBody).digest('hex');}
  async verifyAndParseWebhook(headers:Record<string,string>,rawBody:string):Promise<VerifiedProviderEvent>{const actual=headers['x-provider-signature']??headers['stripe-signature']??headers['x-xpay-signature'];const expected=this.sign(rawBody);let parsed:VerifiedProviderEvent;try{parsed=JSON.parse(rawBody) as VerifiedProviderEvent;}catch{throw new AppError('PAYMENT_PROVIDER_SIGNATURE_INVALID','Invalid provider payload.',400);}
    if(!actual||!safe(actual,expected)){if(!(this.lookupFallback&&parsed.transactionId)){throw new AppError('PAYMENT_PROVIDER_SIGNATURE_INVALID','Provider signature is invalid.',401);}const state=await this.retrievePayment(parsed.transactionId);if(state.status==='PENDING')throw new AppError('PAYMENT_PROVIDER_STATE_UNSUPPORTED','Provider state is not final.',409);return{...state,eventId:parsed.eventId,eventType:state.status==='SUCCEEDED'?'PAYMENT_SUCCEEDED':'PAYMENT_FAILED'};}
    return parsed;
  }
  async refund(input:ProviderRefundInput):Promise<{refundId:string;status:'PENDING'|'SUCCEEDED'|'FAILED'}>{await this.retrievePayment(input.transactionId);return{refundId:`${this.providerKey}_refund_${input.idempotencyKey}`,status:'PENDING' as const};}
  capabilities(){return{webhookSignatures:true,refunds:true,authoritativeLookup:this.lookupFallback};}
}

export class UnconfiguredPaymentAdapter implements PaymentProviderAdapter {
  constructor(private readonly providerKey:string){}
  key(){return this.providerKey;}
  merchantIdentity():string{throw this.error();}
  createPaymentAttempt(_input:ProviderAttemptInput):Promise<ProviderAttemptResult>{return Promise.reject(this.error());}
  retrievePayment(_transactionId:string):Promise<ProviderPaymentState>{return Promise.reject(this.error());}
  verifyAndParseWebhook(_headers:Record<string,string>,_rawBody:string):Promise<VerifiedProviderEvent>{return Promise.reject(this.error());}
  refund(_input:{transactionId:string;amount:string;currencyCode:string;idempotencyKey:string}):Promise<{refundId:string;status:'PENDING'|'SUCCEEDED'|'FAILED'}>{return Promise.reject(this.error());}
  capabilities(){return{webhookSignatures:false,refunds:false,authoritativeLookup:false};}
  private error(){return new AppError('PAYMENT_PROVIDER_NOT_CONFIGURED','Payment provider credentials are not configured.',503,{providerKey:this.providerKey});}
}

/** Provider sandbox for lifecycle/race tests; no real financial effects or production credentials. */
export class DeterministicLifecyclePaymentAdapter extends DeterministicPaymentAdapter {
  readonly refundEffects=new Map<string,{refundId:string;transactionId:string;amount:string;currencyCode:string;status:'PENDING'|'SUCCEEDED'|'FAILED';refundReference?:string;input:string}>();
  private readonly lifecycle=new Map<string,ProviderLifecycleState>();
  private readonly creates=new Map<string,{input:string;result:Awaited<ReturnType<DeterministicPaymentAdapter['createPaymentAttempt']>>}>();
  private readonly effects=new Map<string,{input:string;result:ProviderLifecycleState}>();
  override async refund(input:ProviderRefundInput){
    const identity=JSON.stringify(input),prior=this.refundEffects.get(input.idempotencyKey);
    if(prior){if(prior.input!==identity)throw new AppError('IDEMPOTENCY_CONFLICT','Provider refund key changed.',409);return{refundId:prior.refundId,status:prior.status};}
    const payment=await this.retrieveLifecycle(input.transactionId),amount=toMinor(input.amount,input.currencyCode);
    const held=[...this.refundEffects.values()].filter(r=>r.transactionId===input.transactionId&&r.status!=='FAILED').reduce((sum,r)=>sum+toMinor(r.amount,r.currencyCode),0);
    if(payment.currencyCode!==input.currencyCode||amount<=0||held+amount>toMinor(payment.capturedAmount,payment.currencyCode))throw new AppError('PAYMENT_PROVIDER_REJECTED','Refund exceeds provider captured funds.',502,{providerStatus:400});
    const refundId='re_'+this.refundEffects.size+'_'+input.idempotencyKey;
    this.refundEffects.set(input.idempotencyKey,{...input,refundId,status:'PENDING',input:identity});return{refundId,status:'PENDING' as const};
  }
  override async createPaymentAttempt(input:ProviderAttemptInput){
    const minor=toMinor(input.amount,input.currencyCode);if(minor<=0)throw new AppError('PAYMENT_AMOUNT_INVALID','Payment amount must be positive.',400);
    const identity=JSON.stringify({amount:minor,currency:input.currencyCode,mode:input.mode??'SALE'}),old=this.creates.get(input.idempotencyKey);
    if(old){if(old.input!==identity)throw new AppError('IDEMPOTENCY_CONFLICT','Provider key was used for a different request.',409);return structuredClone(old.result);}
    const result=await super.createPaymentAttempt(input);
    this.lifecycle.set(result.transactionId,{transactionId:result.transactionId,status:'PENDING',amount:input.amount,authorizedAmount:'0',capturedAmount:'0',currencyCode:input.currencyCode,merchantId:this.merchantIdentity()});
    this.creates.set(input.idempotencyKey,{input:identity,result:structuredClone(result)});return result;
  }
  async retrieveLifecycle(id:string){const state=this.lifecycle.get(id);if(!state)throw new AppError('PAYMENT_PROVIDER_TRANSACTION_MISMATCH','Unknown provider transaction.',409);return structuredClone(state);}
  authorize(id:string){const state=this.lifecycle.get(id);if(!state||state.status!=='PENDING')throw new AppError('PAYMENT_INVALID_STATE','Authorization is unavailable.',409);state.status='AUTHORIZED';state.authorizedAmount=state.amount;}
  override settle(id:string,status:'SUCCEEDED'|'FAILED'){
    const state=this.lifecycle.get(id);if(!state||['VOIDED','PAID','PARTIALLY_CAPTURED'].includes(state.status))throw new AppError('PAYMENT_INVALID_STATE','Settlement is unavailable.',409);
    super.settle(id,status);state.status=status==='SUCCEEDED'?'PAID':'FAILED';if(status==='SUCCEEDED'){state.authorizedAmount=state.amount;state.capturedAmount=state.amount;}
  }
  async capture(input:ProviderCaptureInput){
    const identity=JSON.stringify({id:input.transactionId,amount:toMinor(input.amount,input.currencyCode),currency:input.currencyCode}),key='CAPTURE:'+input.idempotencyKey,old=this.effects.get(key);
    if(old){if(old.input!==identity)throw new AppError('IDEMPOTENCY_CONFLICT','Provider key was used for a different request.',409);return structuredClone(old.result);}
    const state=this.lifecycle.get(input.transactionId),amount=toMinor(input.amount,input.currencyCode);
    if(!state||state.currencyCode!==input.currencyCode||!['AUTHORIZED','PARTIALLY_CAPTURED'].includes(state.status))throw new AppError('PAYMENT_INVALID_STATE','Capture is unavailable.',409);
    const captured=toMinor(state.capturedAmount,state.currencyCode),authorized=toMinor(state.authorizedAmount,state.currencyCode);
    if(amount<=0||amount>authorized-captured)throw new AppError('PAYMENT_CAPTURE_EXCEEDS_AUTHORIZATION','Capture exceeds the remaining authorization.',409);
    state.capturedAmount=fromMinor(captured+amount,state.currencyCode);state.status=captured+amount===authorized?'PAID':'PARTIALLY_CAPTURED';
    if(state.status==='PAID')super.settle(input.transactionId,'SUCCEEDED');
    const result=structuredClone(state);this.effects.set(key,{input:identity,result});return structuredClone(result);
  }
  async void(input:ProviderVoidInput){
    const key='VOID:'+input.idempotencyKey,old=this.effects.get(key);
    if(old){if(old.input!==input.transactionId)throw new AppError('IDEMPOTENCY_CONFLICT','Provider key was used for a different request.',409);return structuredClone(old.result);}
    const state=this.lifecycle.get(input.transactionId);
    if(!state||state.capturedAmount!=='0'||!['PENDING','AUTHORIZED'].includes(state.status))throw new AppError('PAYMENT_INVALID_STATE','Only uncaptured attempts can be voided.',409);
    state.status='VOIDED';state.authorizedAmount='0';super.settle(input.transactionId,'FAILED');const result=structuredClone(state);this.effects.set(key,{input:input.transactionId,result});return structuredClone(result);
  }
  override capabilities(){return{webhookSignatures:true,refunds:true,authoritativeLookup:true,authorization:true,capture:true,void:true,multicapture:true};}
}

type JsonObject = Record<string, any>;

abstract class HttpPaymentAdapter {
  protected async request(url:string,init:RequestInit){
    let response:Response;
    try{response=await fetch(url,{...init,signal:AbortSignal.timeout(15000)});}catch{throw new AppError('PAYMENT_PROVIDER_UNAVAILABLE','Payment provider could not be reached.',503);}
    let raw:string;try{raw=await response.text();}catch{throw new AppError('PAYMENT_PROVIDER_UNAVAILABLE','Payment provider response could not be read.',503);}let body:JsonObject={};try{body=raw?JSON.parse(raw):{};}catch{body={message:raw};}
    if(!response.ok)throw new AppError('PAYMENT_PROVIDER_REJECTED','Payment provider rejected the request.',502,{providerStatus:response.status,providerCode:body?.error?.code??body?.code});
    return body;
  }
}

export class StripePaymentAdapter extends HttpPaymentAdapter implements PaymentProviderAdapter {
  constructor(private readonly secretKey:string,private readonly webhookSecret:string,private readonly accountId:string,private readonly multicapture=false){super();}
  key(){return'stripe';}
  merchantIdentity(){return this.accountId;}
  async createPaymentAttempt(input:ProviderAttemptInput){
    const form=new URLSearchParams({amount:String(toMinor(input.amount,input.currencyCode)),currency:input.currencyCode.toLowerCase(),'automatic_payment_methods[enabled]':'true'});
    if(input.mode==='AUTHORIZE')form.set('capture_method','manual');
    const body=await this.request('https://api.stripe.com/v1/payment_intents',{method:'POST',headers:{Authorization:`Bearer ${this.secretKey}`,'Content-Type':'application/x-www-form-urlencoded','Idempotency-Key':input.idempotencyKey},body:form});
    return{transactionId:String(body.id),publicData:{clientSecret:body.client_secret}};
  }
  async retrievePayment(transactionId:string){const body=await this.request(`https://api.stripe.com/v1/payment_intents/${encodeURIComponent(transactionId)}`,{headers:{Authorization:`Bearer ${this.secretKey}`}});return this.paymentState(body);}
  async retrieveLifecycle(transactionId:string){const body=await this.request(`https://api.stripe.com/v1/payment_intents/${encodeURIComponent(transactionId)}`,{headers:{Authorization:`Bearer ${this.secretKey}`}});const state=this.lifecycleState(body);this.assertIdentity(state,transactionId,state.currencyCode);return state;}
  verifyCommerceWebhook(headers:Headers,rawBody:string):ProviderCommerceEvent{
    verifyTimestampSignature(headers.get('stripe-signature')??undefined,this.webhookSecret,rawBody);
    let raw:unknown;try{raw=JSON.parse(rawBody);}catch{throw invalidSignature('Invalid provider payload.');}
    const root=parse(z.object({type:z.string()}),raw);
    if(root.type.startsWith('refund.'))return this.refundEvent(raw);
    if(!root.type.startsWith('charge.dispute.'))return this.verifyLifecycleWebhook(headers,rawBody);
    const instant=z.number().int().nonnegative().max(253402300799);
    const reference=z.union([z.string().min(1).max(160),z.object({id:z.string().min(1).max(160)})]).transform(v=>typeof v==='string'?v:v.id);
    const event=parse(z.object({id:z.string().min(1).max(160),created:instant,account:z.string().optional(),type:z.enum(['charge.dispute.created','charge.dispute.updated','charge.dispute.closed']),data:z.object({object:z.object({
      id:z.string().min(1).max(160),object:z.literal('dispute'),payment_intent:reference,charge:reference,created:instant,amount:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),currency:z.string().regex(/^[a-zA-Z]{3}$/),
      status:z.enum(['needs_response','under_review','won','lost','warning_needs_response','warning_under_review','warning_closed','prevented']),
      reason:z.enum(['bank_cannot_process','check_returned','credit_not_processed','customer_initiated','debit_not_authorized','duplicate','fraudulent','general','incorrect_account_details','insufficient_funds','noncompliant','product_not_received','product_unacceptable','subscription_canceled','unrecognized']),
      evidence_details:z.object({has_evidence:z.boolean(),past_due:z.boolean(),submission_count:z.number().int().min(0).max(100000),due_by:instant.nullable()})
    })})}),raw);
    const d=event.data.object;
    if(event.created>Date.now()/1000+60||d.created>event.created||event.account&&event.account!==this.accountId)throw invalidSignature('Provider event identity or timestamp is invalid.');
    const status:ProviderDisputeEvent['status']=d.status==='lost'?'LOST':['won','warning_closed','prevented'].includes(d.status)?'WON':['needs_response','warning_needs_response'].includes(d.status)?'EVIDENCE_REQUIRED':'SUBMITTED';
    if(event.type==='charge.dispute.closed'&&!['WON','LOST'].includes(status))throw new AppError('PAYMENT_DISPUTE_INVALID','Closed dispute has a nonterminal provider state.',409);
    return{kind:'DISPUTE',eventId:event.id,occurredAt:new Date(event.created*1000).toISOString(),transactionId:d.payment_intent,merchantId:this.accountId,disputeId:d.id,chargeId:d.charge,amount:fromMinor(d.amount,d.currency),currencyCode:d.currency.toUpperCase(),providerStatus:d.status,status,openedAt:new Date(d.created*1000).toISOString(),reason:d.reason,
      evidence:{hasEvidence:d.evidence_details.has_evidence,pastDue:d.evidence_details.past_due,submissionCount:d.evidence_details.submission_count,dueAt:d.evidence_details.due_by===null?null:new Date(d.evidence_details.due_by*1000).toISOString()}};
  }
  verifyLifecycleWebhook(headers:Headers,rawBody:string):ProviderLifecycleEvent{
    verifyTimestampSignature(headers.get('stripe-signature')??undefined,this.webhookSecret,rawBody);
    let raw:unknown;try{raw=JSON.parse(rawBody);}catch{throw invalidSignature('Invalid provider payload.');}
    const event=parse(z.object({id:z.string().min(1).max(160),created:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),account:z.string().optional(),
      type:z.enum(['payment_intent.amount_capturable_updated','payment_intent.succeeded','payment_intent.canceled','payment_intent.payment_failed','payment_intent.processing']),
      data:z.object({object:z.record(z.string(),z.unknown())}),request:z.object({idempotency_key:z.string().nullish()}).nullish()}),raw);
    if(event.created>Date.now()/1000+60||event.account&&event.account!==this.accountId)throw invalidSignature('Provider event identity or timestamp is invalid.');
    const state=this.lifecycleState(event.data.object),failed=event.type==='payment_intent.payment_failed';
    if(failed&&state.capturedAmount==='0'&&state.authorizedAmount==='0')state.status='FAILED';
    else if(failed&&state.capturedAmount!=='0')state.status=state.capturedAmount===state.amount?'PAID':'PARTIALLY_CAPTURED';
    const key=event.request?.idempotency_key;
    return{...state,eventId:event.id,occurredAt:new Date(event.created*1000).toISOString(),failed,
      ...(key&&/^payment-command:[a-f0-9-]{36}$/.test(key)?{operationKey:key}:{})};
  }
  async capture(input:ProviderCaptureInput){
    const amount=toMinor(input.amount,input.currencyCode);
    if(amount<=0)throw new AppError('PAYMENT_AMOUNT_INVALID','Capture amount must be positive.',400);
    const form=new URLSearchParams({amount_to_capture:String(amount),final_capture:String(!this.multicapture)});
    const body=await this.request(`https://api.stripe.com/v1/payment_intents/${encodeURIComponent(input.transactionId)}/capture`,{method:'POST',headers:{Authorization:`Bearer ${this.secretKey}`,'Content-Type':'application/x-www-form-urlencoded','Idempotency-Key':input.idempotencyKey},body:form});
    const state=this.lifecycleState(body);this.assertIdentity(state,input.transactionId,input.currencyCode);return state;
  }
  async void(input:ProviderVoidInput){
    const current=await this.retrieveLifecycle(input.transactionId);
    if(current.status==='VOIDED')return current;
    if(current.capturedAmount!=='0'||!['PENDING','AUTHORIZED'].includes(current.status))throw new AppError('PAYMENT_INVALID_STATE','Only uncaptured payment attempts can be voided.',409);
    const body=await this.request(`https://api.stripe.com/v1/payment_intents/${encodeURIComponent(input.transactionId)}/cancel`,{method:'POST',headers:{Authorization:`Bearer ${this.secretKey}`,'Content-Type':'application/x-www-form-urlencoded','Idempotency-Key':input.idempotencyKey},body:new URLSearchParams()});
    const state=this.lifecycleState(body);this.assertIdentity(state,input.transactionId,current.currencyCode);return state;
  }
  async verifyAndParseWebhook(headers:Record<string,string>,rawBody:string):Promise<VerifiedProviderEvent>{
    verifyTimestampSignature(headers['stripe-signature'],this.webhookSecret,rawBody);
    let event:JsonObject;try{event=JSON.parse(rawBody);}catch{throw invalidSignature('Invalid provider payload.');}
    const object=event?.data?.object??{};const type=String(event.type??'');
    if(type.startsWith('refund.'))return{eventId:String(event.id),eventType:String(object.status).toLowerCase()==='failed'?'REFUND_FAILED':'REFUND_SUCCEEDED',transactionId:String(object.payment_intent),status:String(object.status).toLowerCase()==='failed'?'FAILED':'SUCCEEDED',amount:fromMinor(Number(object.amount),String(object.currency)),currencyCode:String(object.currency).toUpperCase(),merchantId:String(event.account??this.accountId),refundId:String(object.id)} as VerifiedProviderEvent;
    if(!['payment_intent.succeeded','payment_intent.payment_failed','payment_intent.canceled'].includes(type))throw new AppError('PAYMENT_PROVIDER_STATE_UNSUPPORTED','Unsupported Stripe event type.',409,{eventType:type});
    const state=this.paymentState(object);const eventType:VerifiedProviderEvent['eventType']=type==='payment_intent.succeeded'?'PAYMENT_SUCCEEDED':'PAYMENT_FAILED';return{...state,eventId:String(event.id),eventType};
  }
  async refund(input:ProviderRefundInput){const form=new URLSearchParams({payment_intent:input.transactionId,amount:String(toMinor(input.amount,input.currencyCode))});if(input.refundReference)form.set('metadata[truecrm_refund_id]',input.refundReference);const body=await this.request('https://api.stripe.com/v1/refunds',{method:'POST',headers:{Authorization:`Bearer ${this.secretKey}`,'Content-Type':'application/x-www-form-urlencoded','Idempotency-Key':input.idempotencyKey},body:form});
    const refund=this.refundObject(body);if(refund.transactionId!==input.transactionId||refund.currencyCode!==input.currencyCode||toMinor(refund.amount,input.currencyCode)!==toMinor(input.amount,input.currencyCode))throw new AppError('PAYMENT_PROVIDER_TRANSACTION_MISMATCH','Refund response identity mismatch.',409);
    return{refundId:refund.refundId,status:refund.status==='CANCELLED'?'FAILED' as const:refund.status};}
  private refundObject(raw:unknown){
    const reference=z.union([z.string().min(1).max(160),z.object({id:z.string().min(1).max(160)})]).transform(v=>typeof v==='string'?v:v.id);
    const r=parse(z.object({id:z.string().min(1).max(160),object:z.literal('refund'),payment_intent:reference,amount:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),currency:z.string().regex(/^[a-zA-Z]{3}$/),status:z.enum(['pending','requires_action','succeeded','failed','canceled']),metadata:z.record(z.string(),z.string()).nullish()}),raw);
    return{refundId:r.id,transactionId:r.payment_intent,amount:fromMinor(r.amount,r.currency),currencyCode:r.currency.toUpperCase(),status:(r.status==='succeeded'?'SUCCEEDED':r.status==='failed'?'FAILED':r.status==='canceled'?'CANCELLED':'PENDING') as ProviderRefundEvent['status'],refundReference:r.metadata?.truecrm_refund_id};
  }
  private refundEvent(raw:unknown):ProviderRefundEvent{
    const event=parse(z.object({id:z.string().min(1).max(160),created:z.number().int().nonnegative().max(253402300799),account:z.string().optional(),type:z.enum(['refund.created','refund.updated','refund.failed']),data:z.object({object:z.unknown()}),request:z.object({idempotency_key:z.string().nullish()}).nullish()}),raw);
    if(event.created>Date.now()/1000+60||event.account&&event.account!==this.accountId)throw invalidSignature('Provider event identity or timestamp is invalid.');
    const refund=this.refundObject(event.data.object),key=event.request?.idempotency_key;
    if(event.type==='refund.failed'&&refund.status!=='FAILED')throw new AppError('PAYMENT_PROVIDER_STATE_UNSUPPORTED','Failed refund event must contain a failed refund.',409);
    if(refund.refundReference&&!z.uuid().safeParse(refund.refundReference).success)throw new AppError('PAYMENT_PROVIDER_TRANSACTION_MISMATCH','Refund reference is invalid.',409);
    return{...refund,kind:'REFUND',eventId:event.id,occurredAt:new Date(event.created*1000).toISOString(),merchantId:this.accountId,...(key&&/^refund-command:[a-f0-9-]{36}$/.test(key)?{operationKey:key}:{})};
  }
  capabilities(){return{webhookSignatures:true,refunds:true,authoritativeLookup:true,authorization:true,capture:true,void:true,multicapture:this.multicapture};}
  private assertIdentity(state:ProviderLifecycleState,id:string,currency:string){if(state.transactionId!==id||state.currencyCode!==currency)throw new AppError('PAYMENT_PROVIDER_TRANSACTION_MISMATCH','Provider payment identity mismatch.',409);}
  private lifecycleState(body:JsonObject):ProviderLifecycleState{
    const id=String(body.id??''),currency=String(body.currency??'').toUpperCase(),amount=Number(body.amount),captured=Number(body.amount_received),remaining=Number(body.amount_capturable);
    if(!id||!currency.match(/^[A-Z]{3}$/)||![amount,captured,remaining,captured+remaining].every(n=>Number.isSafeInteger(n)&&n>=0)||captured+remaining>amount)throw new AppError('PAYMENT_PROVIDER_AMOUNT_MISMATCH','Provider returned invalid lifecycle amounts.',409);
    const status=String(body.status);let state:ProviderLifecycleState['status'];
    if(status==='canceled')state=captured>0?'PARTIALLY_CAPTURED':'VOIDED';
    else if(status==='succeeded')state=captured===amount?'PAID':'PARTIALLY_CAPTURED';
    else if(status==='requires_capture')state=captured>0?'PARTIALLY_CAPTURED':'AUTHORIZED';
    else if(['requires_payment_method','requires_confirmation','requires_action','processing'].includes(status))state='PENDING';
    else throw new AppError('PAYMENT_PROVIDER_STATE_UNSUPPORTED','Provider returned an unsupported lifecycle state.',409);
    return{transactionId:id,status:state,amount:fromMinor(amount,currency),authorizedAmount:fromMinor(captured+remaining,currency),capturedAmount:fromMinor(captured,currency),currencyCode:currency,merchantId:this.accountId};
  }
  private paymentState(body:JsonObject):ProviderPaymentState{return{transactionId:String(body.id),status:String(body.status)==='succeeded'?'SUCCEEDED':['canceled','payment_failed'].includes(String(body.status))?'FAILED':'PENDING',amount:fromMinor(Number(body.amount),String(body.currency)),currencyCode:String(body.currency).toUpperCase(),merchantId:this.accountId};}
}

export class XPayPaymentAdapter extends HttpPaymentAdapter implements PaymentProviderAdapter {
  constructor(private readonly secretKey:string,private readonly webhookSecret:string,private readonly accountId:string,private readonly returnUrl:string,private readonly apiBase='https://api.xpay.app'){super();}
  key(){return'xpay';}
  merchantIdentity(){return this.accountId;}
  async createPaymentAttempt(input:ProviderAttemptInput){if(input.mode==='AUTHORIZE')throw new AppError('PAYMENT_PROVIDER_STATE_UNSUPPORTED','Provider does not support authorization commands.',422);const body=await this.request(`${this.apiBase}/checkout/sessions`,{method:'POST',headers:{Authorization:`Bearer ${this.secretKey}`,'Content-Type':'application/json','Idempotency-Key':input.idempotencyKey},body:JSON.stringify({afterCompletion:{type:'redirect',redirect:{url:this.returnUrl}},lineItems:[{priceData:{currency:input.currencyCode.toUpperCase(),unitAmount:toMinor(input.amount,input.currencyCode),productData:{name:'TrueCRM invoice payment'}},quantity:1}],metadata:{idempotencyKey:input.idempotencyKey}})});return{transactionId:String(body.id),checkoutUrl:String(body.url),publicData:{sessionId:body.id}};}
  async retrievePayment(transactionId:string){const body=await this.session(transactionId);return this.sessionState(body);}
  async verifyAndParseWebhook(headers:Record<string,string>,rawBody:string):Promise<VerifiedProviderEvent>{verifyTimestampSignature(headers['xpay-signature']??headers['x-pay-signature'],this.webhookSecret,rawBody);let event:JsonObject;try{event=JSON.parse(rawBody);}catch{throw invalidSignature('Invalid provider payload.');}const object=event?.data?.object??{};const type=String(event.type??'');
    if(type.startsWith('refund.'))return{eventId:String(event.id),eventType:String(object.status).toUpperCase()==='FAILED'?'REFUND_FAILED':'REFUND_SUCCEEDED',transactionId:String(object.metadata?.checkoutSessionId??object.paymentIntentId),status:String(object.status).toUpperCase()==='FAILED'?'FAILED':'SUCCEEDED',amount:fromMinor(Number(object.amount),String(object.currency)),currencyCode:String(object.currency).toUpperCase(),merchantId:String(object.merchantId??this.accountId),refundId:String(object.id)} as VerifiedProviderEvent;
    if(!type.startsWith('checkout.session.'))throw new AppError('PAYMENT_PROVIDER_STATE_UNSUPPORTED','Unsupported XPay event type.',409,{eventType:type});
    const state=this.sessionState(object);if(state.status==='PENDING')throw new AppError('PAYMENT_PROVIDER_STATE_UNSUPPORTED','XPay payment is not final.',409);const eventType:VerifiedProviderEvent['eventType']=state.status==='SUCCEEDED'?'PAYMENT_SUCCEEDED':'PAYMENT_FAILED';return{...state,eventId:String(event.id),eventType};}
  async refund(input:{transactionId:string;amount:string;currencyCode:string;idempotencyKey:string}){const session=await this.session(input.transactionId);const paymentIntentId=String(session.paymentIntentId??session.paymentIntent?.id??'');if(!paymentIntentId)throw new AppError('PAYMENT_PROVIDER_TRANSACTION_MISMATCH','XPay payment intent was not found.',409);const body=await this.request(`${this.apiBase}/refunds`,{method:'POST',headers:{Authorization:`Bearer ${this.secretKey}`,'Content-Type':'application/json','Idempotency-Key':input.idempotencyKey},body:JSON.stringify({paymentIntentId,amount:toMinor(input.amount,input.currencyCode),metadata:{checkoutSessionId:input.transactionId}})});return{refundId:String(body.id),status:refundStatus(body.status)};}
  capabilities(){return{webhookSignatures:true,refunds:true,authoritativeLookup:true};}
  private session(id:string){return this.request(`${this.apiBase}/checkout/sessions/${encodeURIComponent(id)}`,{headers:{Authorization:`Bearer ${this.secretKey}`}});}
  private sessionState(body:JsonObject):ProviderPaymentState{return{transactionId:String(body.id),status:String(body.paymentStatus).toLowerCase()==='paid'?'SUCCEEDED':String(body.status).toLowerCase()==='expired'?'FAILED':'PENDING',amount:fromMinor(Number(body.amountTotal),String(body.currency)),currencyCode:String(body.currency).toUpperCase(),merchantId:String(body.merchantId??this.accountId)};}
}

function verifyTimestampSignature(header:string|undefined,secret:string,rawBody:string){
  if(!header||header.length>8192)throw invalidSignature('Provider signature is missing or invalid.');
  const parts=header.split(',').map(part=>{const [key,...value]=part.trim().split('=');return{key,value:value.join('=')};}),times=parts.filter(part=>part.key==='t'),signatures=parts.filter(part=>part.key==='v1');
  const timestamp=times[0]?.value;
  if(times.length!==1||!timestamp||!/^\d{10}$/.test(timestamp)||Math.abs(Date.now()/1000-Number(timestamp))>300)throw invalidSignature('Provider signature timestamp is invalid.');
  const expected=createHmac('sha256',secret).update(`${timestamp}.${rawBody}`).digest('hex');
  if(!signatures.some(signature=>/^[a-f0-9]{64}$/.test(signature.value)&&safe(signature.value,expected)))throw invalidSignature('Provider signature is invalid.');
}
function invalidSignature(message:string){return new AppError('PAYMENT_PROVIDER_SIGNATURE_INVALID',message,401);}
function refundStatus(value:unknown):'PENDING'|'SUCCEEDED'|'FAILED'{const status=String(value??'').toLowerCase();return['succeeded','successful','completed'].includes(status)?'SUCCEEDED':['failed','canceled','cancelled'].includes(status)?'FAILED':'PENDING';}
function currencyDigits(currency:string){return['BIF','CLP','DJF','GNF','JPY','KMF','KRW','MGA','PYG','RWF','UGX','VND','VUV','XAF','XOF','XPF'].includes(currency.toUpperCase())?0:['BHD','JOD','KWD','OMR','TND'].includes(currency.toUpperCase())?3:2;}
function toMinor(amount:string,currency:string){const digits=currencyDigits(currency);const match=/^(\d+)(?:\.(\d+))?$/.exec(amount);if(!match)throw new AppError('PAYMENT_AMOUNT_INVALID','Provider amount is invalid.',400);const fraction=match[2]??'';if(fraction.length>digits&&/[1-9]/.test(fraction.slice(digits)))throw new AppError('PAYMENT_AMOUNT_INVALID','Amount exceeds provider currency precision.',400);const value=BigInt(match[1])*10n**BigInt(digits)+BigInt((fraction.slice(0,digits)+'0'.repeat(digits)).slice(0,digits)||'0');if(value>BigInt(Number.MAX_SAFE_INTEGER))throw new AppError('PAYMENT_AMOUNT_INVALID','Provider amount is too large.',400);return Number(value);}
function fromMinor(amount:number,currency:string){if(!Number.isSafeInteger(amount)||amount<0)throw new AppError('PAYMENT_PROVIDER_AMOUNT_MISMATCH','Provider returned an invalid amount.',409);const digits=currencyDigits(currency);if(!digits)return String(amount);const raw=String(amount).padStart(digits+1,'0');const whole=raw.slice(0,-digits);const fraction=raw.slice(-digits).replace(/0+$/,'');return fraction?`${whole}.${fraction}`:whole;}
export function positiveProviderAmount(amount:string,currency:string){const minor=toMinor(amount,currency);if(minor<=0)throw new AppError('PAYMENT_AMOUNT_INVALID','Payment amount must be positive.',400);return fromMinor(minor,currency);}
function safe(a:string,b:string){const x=Buffer.from(a);const y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);}

export class PaymentProviderRegistry {
  private readonly adapters=new Map<string,PaymentProviderAdapter>();
  register(adapter:PaymentProviderAdapter){this.adapters.set(adapter.key(),adapter);return this;}
  get(key:string){const adapter=this.adapters.get(key);if(!adapter)throw new AppError('PAYMENT_PROVIDER_NOT_CONFIGURED','Payment provider is not configured.',409,{providerKey:key});return adapter;}
  keys(){return [...this.adapters.keys()];}
}
