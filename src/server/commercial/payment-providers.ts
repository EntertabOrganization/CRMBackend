import { createHmac, timingSafeEqual } from 'crypto';
import { AppError } from '../errors';

export type ProviderAttemptInput = { amount:string; currencyCode:string; idempotencyKey:string };
export type ProviderAttemptResult = { transactionId:string; checkoutUrl?:string; publicData?:Record<string,unknown> };
export type ProviderPaymentState = { transactionId:string; status:'PENDING'|'SUCCEEDED'|'FAILED'; amount:string; currencyCode:string; merchantId:string };
export type VerifiedProviderEvent = ProviderPaymentState & { eventId:string; eventType:'PAYMENT_SUCCEEDED'|'PAYMENT_FAILED'|'REFUND_SUCCEEDED'|'REFUND_FAILED'; refundId?:string };
export interface PaymentProviderAdapter {
  key():string; merchantIdentity():string; createPaymentAttempt(input:ProviderAttemptInput):Promise<ProviderAttemptResult>; retrievePayment(transactionId:string):Promise<ProviderPaymentState>;
  verifyAndParseWebhook(headers:Record<string,string>,rawBody:string):Promise<VerifiedProviderEvent>; refund(input:{transactionId:string;amount:string;currencyCode:string;idempotencyKey:string}):Promise<{refundId:string;status:'PENDING'|'SUCCEEDED'|'FAILED'}>;
  capabilities():{webhookSignatures:boolean;refunds:boolean;authoritativeLookup:boolean};
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
  async refund(input:{transactionId:string;amount:string;currencyCode:string;idempotencyKey:string}){await this.retrievePayment(input.transactionId);return{refundId:`${this.providerKey}_refund_${input.idempotencyKey}`,status:'PENDING' as const};}
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

type JsonObject = Record<string, any>;

abstract class HttpPaymentAdapter {
  protected async request(url:string,init:RequestInit){
    let response:Response;
    try{response=await fetch(url,init);}catch{throw new AppError('PAYMENT_PROVIDER_UNAVAILABLE','Payment provider could not be reached.',503);}
    const raw=await response.text();let body:JsonObject={};try{body=raw?JSON.parse(raw):{};}catch{body={message:raw};}
    if(!response.ok)throw new AppError('PAYMENT_PROVIDER_REJECTED','Payment provider rejected the request.',502,{providerStatus:response.status,providerCode:body?.error?.code??body?.code});
    return body;
  }
}

export class StripePaymentAdapter extends HttpPaymentAdapter implements PaymentProviderAdapter {
  constructor(private readonly secretKey:string,private readonly webhookSecret:string,private readonly accountId:string){super();}
  key(){return'stripe';}
  merchantIdentity(){return this.accountId;}
  async createPaymentAttempt(input:ProviderAttemptInput){
    const form=new URLSearchParams({amount:String(toMinor(input.amount,input.currencyCode)),currency:input.currencyCode.toLowerCase(),'automatic_payment_methods[enabled]':'true'});
    const body=await this.request('https://api.stripe.com/v1/payment_intents',{method:'POST',headers:{Authorization:`Bearer ${this.secretKey}`,'Content-Type':'application/x-www-form-urlencoded','Idempotency-Key':input.idempotencyKey},body:form});
    return{transactionId:String(body.id),publicData:{clientSecret:body.client_secret}};
  }
  async retrievePayment(transactionId:string){const body=await this.request(`https://api.stripe.com/v1/payment_intents/${encodeURIComponent(transactionId)}`,{headers:{Authorization:`Bearer ${this.secretKey}`}});return this.paymentState(body);}
  async verifyAndParseWebhook(headers:Record<string,string>,rawBody:string):Promise<VerifiedProviderEvent>{
    verifyTimestampSignature(headers['stripe-signature'],this.webhookSecret,rawBody);
    let event:JsonObject;try{event=JSON.parse(rawBody);}catch{throw invalidSignature('Invalid provider payload.');}
    const object=event?.data?.object??{};const type=String(event.type??'');
    if(type.startsWith('refund.'))return{eventId:String(event.id),eventType:String(object.status).toLowerCase()==='failed'?'REFUND_FAILED':'REFUND_SUCCEEDED',transactionId:String(object.payment_intent),status:String(object.status).toLowerCase()==='failed'?'FAILED':'SUCCEEDED',amount:fromMinor(Number(object.amount),String(object.currency)),currencyCode:String(object.currency).toUpperCase(),merchantId:String(event.account??this.accountId),refundId:String(object.id)} as VerifiedProviderEvent;
    if(!['payment_intent.succeeded','payment_intent.payment_failed','payment_intent.canceled'].includes(type))throw new AppError('PAYMENT_PROVIDER_STATE_UNSUPPORTED','Unsupported Stripe event type.',409,{eventType:type});
    const state=this.paymentState(object);const eventType:VerifiedProviderEvent['eventType']=type==='payment_intent.succeeded'?'PAYMENT_SUCCEEDED':'PAYMENT_FAILED';return{...state,eventId:String(event.id),eventType};
  }
  async refund(input:{transactionId:string;amount:string;currencyCode:string;idempotencyKey:string}){const form=new URLSearchParams({payment_intent:input.transactionId,amount:String(toMinor(input.amount,input.currencyCode))});const body=await this.request('https://api.stripe.com/v1/refunds',{method:'POST',headers:{Authorization:`Bearer ${this.secretKey}`,'Content-Type':'application/x-www-form-urlencoded','Idempotency-Key':input.idempotencyKey},body:form});return{refundId:String(body.id),status:refundStatus(body.status)};}
  capabilities(){return{webhookSignatures:true,refunds:true,authoritativeLookup:true};}
  private paymentState(body:JsonObject):ProviderPaymentState{return{transactionId:String(body.id),status:String(body.status)==='succeeded'?'SUCCEEDED':['canceled','payment_failed'].includes(String(body.status))?'FAILED':'PENDING',amount:fromMinor(Number(body.amount),String(body.currency)),currencyCode:String(body.currency).toUpperCase(),merchantId:this.accountId};}
}

export class XPayPaymentAdapter extends HttpPaymentAdapter implements PaymentProviderAdapter {
  constructor(private readonly secretKey:string,private readonly webhookSecret:string,private readonly accountId:string,private readonly returnUrl:string,private readonly apiBase='https://api.xpay.app'){super();}
  key(){return'xpay';}
  merchantIdentity(){return this.accountId;}
  async createPaymentAttempt(input:ProviderAttemptInput){const body=await this.request(`${this.apiBase}/checkout/sessions`,{method:'POST',headers:{Authorization:`Bearer ${this.secretKey}`,'Content-Type':'application/json','Idempotency-Key':input.idempotencyKey},body:JSON.stringify({afterCompletion:{type:'redirect',redirect:{url:this.returnUrl}},lineItems:[{priceData:{currency:input.currencyCode.toUpperCase(),unitAmount:toMinor(input.amount,input.currencyCode),productData:{name:'TrueCRM invoice payment'}},quantity:1}],metadata:{idempotencyKey:input.idempotencyKey}})});return{transactionId:String(body.id),checkoutUrl:String(body.url),publicData:{sessionId:body.id}};}
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

function verifyTimestampSignature(header:string|undefined,secret:string,rawBody:string){if(!header)throw invalidSignature('Provider signature is missing.');const parts=Object.fromEntries(header.split(',').map(part=>{const [key,...value]=part.trim().split('=');return[key,value.join('=')];}));const timestamp=Number(parts.t);if(!Number.isFinite(timestamp)||Math.abs(Date.now()/1000-timestamp)>300)throw invalidSignature('Provider signature timestamp is invalid.');const expected=createHmac('sha256',secret).update(`${parts.t}.${rawBody}`).digest('hex');if(!parts.v1||!safe(parts.v1,expected))throw invalidSignature('Provider signature is invalid.');}
function invalidSignature(message:string){return new AppError('PAYMENT_PROVIDER_SIGNATURE_INVALID',message,401);}
function refundStatus(value:unknown):'PENDING'|'SUCCEEDED'|'FAILED'{const status=String(value??'').toLowerCase();return['succeeded','successful','completed'].includes(status)?'SUCCEEDED':['failed','canceled','cancelled'].includes(status)?'FAILED':'PENDING';}
function currencyDigits(currency:string){return['BIF','CLP','DJF','GNF','JPY','KMF','KRW','MGA','PYG','RWF','UGX','VND','VUV','XAF','XOF','XPF'].includes(currency.toUpperCase())?0:['BHD','JOD','KWD','OMR','TND'].includes(currency.toUpperCase())?3:2;}
function toMinor(amount:string,currency:string){const digits=currencyDigits(currency);const match=/^(\d+)(?:\.(\d+))?$/.exec(amount);if(!match)throw new AppError('PAYMENT_AMOUNT_INVALID','Provider amount is invalid.',400);const fraction=match[2]??'';if(fraction.length>digits&&/[1-9]/.test(fraction.slice(digits)))throw new AppError('PAYMENT_AMOUNT_INVALID','Amount exceeds provider currency precision.',400);const value=BigInt(match[1])*10n**BigInt(digits)+BigInt((fraction.slice(0,digits)+'0'.repeat(digits)).slice(0,digits)||'0');if(value>BigInt(Number.MAX_SAFE_INTEGER))throw new AppError('PAYMENT_AMOUNT_INVALID','Provider amount is too large.',400);return Number(value);}
function fromMinor(amount:number,currency:string){if(!Number.isSafeInteger(amount)||amount<0)throw new AppError('PAYMENT_PROVIDER_AMOUNT_MISMATCH','Provider returned an invalid amount.',409);const digits=currencyDigits(currency);if(!digits)return String(amount);const raw=String(amount).padStart(digits+1,'0');const whole=raw.slice(0,-digits);const fraction=raw.slice(-digits).replace(/0+$/,'');return fraction?`${whole}.${fraction}`:whole;}
function safe(a:string,b:string){const x=Buffer.from(a);const y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);}

export class PaymentProviderRegistry {
  private readonly adapters=new Map<string,PaymentProviderAdapter>();
  register(adapter:PaymentProviderAdapter){this.adapters.set(adapter.key(),adapter);return this;}
  get(key:string){const adapter=this.adapters.get(key);if(!adapter)throw new AppError('PAYMENT_PROVIDER_NOT_CONFIGURED','Payment provider is not configured.',409,{providerKey:key});return adapter;}
  keys(){return [...this.adapters.keys()];}
}
