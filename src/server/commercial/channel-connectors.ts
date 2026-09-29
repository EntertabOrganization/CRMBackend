import { createHmac, timingSafeEqual } from 'crypto';
import { AppError } from '../errors';

export type NormalizedChannelEvent={eventId:string;externalConversationId:string;externalIdentity:string;externalMessageId:string;eventType:'MESSAGE'|'DELIVERED'|'READ'|'FAILED';occurredAt:Date;text?:string;messageType?:string};
export interface ChannelConnector { key():string; verifyInbound(headers:Record<string,string>,rawBody:string):Promise<unknown>; normalizeInbound(event:unknown):NormalizedChannelEvent; sendMessage(input:{conversationId:string;localMessageId:string;text:string}):Promise<{externalMessageId:string;status:'SENT'|'DELIVERED'}>; capabilities():{deliveryStates:string[];media:boolean}; }
export class DeterministicChannelConnector implements ChannelConnector {
  sends:string[]=[]; failNext=false;
  constructor(private readonly providerKey:string,private readonly secret:string,private readonly states:string[]=['SENT','DELIVERED']){}
  key(){return this.providerKey;}
  sign(raw:string){return createHmac('sha256',this.secret).update(raw).digest('hex');}
  async verifyInbound(headers:Record<string,string>,rawBody:string){const sig=headers['x-channel-signature'];const expected=this.sign(rawBody);const a=Buffer.from(sig??''),b=Buffer.from(expected);if(a.length!==b.length||!timingSafeEqual(a,b))throw new AppError('CHANNEL_PROVIDER_VERIFICATION_FAILED','Channel provider verification failed.',401);try{return JSON.parse(rawBody);}catch{throw new AppError('CHANNEL_EVENT_INVALID','Channel event is invalid.',400);}}
  normalizeInbound(event:any):NormalizedChannelEvent{return{eventId:String(event.eventId),externalConversationId:String(event.externalConversationId??event.threadId??''),externalIdentity:String(event.externalIdentity),externalMessageId:String(event.externalMessageId),eventType:event.eventType??'MESSAGE',occurredAt:new Date(event.occurredAt??Date.now()),text:event.text===undefined?undefined:String(event.text),messageType:event.messageType??'TEXT'};}
  async sendMessage(input:{conversationId:string;localMessageId:string;text:string}){if(this.failNext){this.failNext=false;throw new AppError('CHANNEL_SEND_FAILED','Deterministic provider failure.',503);}this.sends.push(input.localMessageId);return{externalMessageId:`${this.providerKey}_${input.localMessageId}`,status:'SENT' as const};}
  capabilities(){return{deliveryStates:[...this.states],media:true};}
}
export class UnconfiguredChannelConnector implements ChannelConnector {
  constructor(private readonly providerKey:string){}
  key(){return this.providerKey;}
  verifyInbound():Promise<unknown>{return Promise.reject(this.error());}
  normalizeInbound():NormalizedChannelEvent{throw this.error();}
  sendMessage():Promise<{externalMessageId:string;status:'SENT'|'DELIVERED'}>{return Promise.reject(this.error());}
  capabilities():{deliveryStates:string[];media:boolean}{throw this.error();}
  private error(){return new AppError('CHANNEL_CONNECTOR_NOT_CONFIGURED','Channel connector credentials are not configured.',503,{providerKey:this.providerKey});}
}
export class ChannelConnectorRegistry { private adapters=new Map<string,ChannelConnector>(); register(x:ChannelConnector){this.adapters.set(x.key(),x);return this;} get(key:string){const x=this.adapters.get(key);if(!x)throw new AppError('CHANNEL_CONNECTION_NOT_FOUND','Channel connector is not configured.',404);return x;} }
