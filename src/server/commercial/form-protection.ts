import { createHmac, timingSafeEqual } from 'crypto';
import { AppError } from '../errors';

export interface FormProtectionAdapter { key():string; verify(input:{token?:string;publicKey:string;payload:Record<string,unknown>;config:Record<string,unknown>}):void; }

export class HmacFormProtectionAdapter implements FormProtectionAdapter {
  constructor(private readonly secret:string){}
  key(){return'hmac';}
  token(publicKey:string){return createHmac('sha256',this.secret).update(publicKey).digest('hex');}
  verify(input:{token?:string;publicKey:string}){const expected=this.token(input.publicKey);const actual=input.token??'';const a=Buffer.from(actual),b=Buffer.from(expected);if(a.length!==b.length||!timingSafeEqual(a,b))throw new AppError('FORM_SPAM_CHECK_FAILED','Form protection verification failed.',403);}
}

export class FormProtectionRegistry {
  private readonly adapters=new Map<string,FormProtectionAdapter>();
  register(adapter:FormProtectionAdapter){this.adapters.set(adapter.key(),adapter);return this;}
  get(key:string){const adapter=this.adapters.get(key);if(!adapter)throw new AppError('FORM_SPAM_POLICY_INVALID','Configured form protection adapter is unavailable.',409,{adapterKey:key});return adapter;}
}
