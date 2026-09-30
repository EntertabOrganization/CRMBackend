import { createHash, randomBytes } from 'crypto';
import type { ActorContext } from '../access-service';
import { AppError, conflict, forbidden } from '../errors';
import { sanitizeAuditPayload } from '../sanitize';
import type { InMemoryStore } from '../store';
import type { IntelligenceJob } from './types';

export function stableHash(value: unknown) {
  const canonicalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonicalize);
    if (input instanceof Date) return input.toISOString();
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, canonicalize(entry)]),
      );
    }
    return input;
  };
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

export function issueSecret(prefix = 'trm') {
  const raw = `${prefix}_${randomBytes(24).toString('base64url')}`;
  return { raw, prefix: raw.slice(0, Math.min(12, raw.length)), hash: createHash('sha256').update(raw).digest('hex') };
}

export function verifySecret(raw: string, expectedHash: string) {
  return createHash('sha256').update(raw).digest('hex') === expectedHash;
}

export class EntitlementService {
  constructor(private readonly store: InMemoryStore) {}
  set(workspaceId:string, capability:string, enabled:boolean, limit?:number|null) {
    let grant=this.store.state.entitlementGrants.find(x=>x.workspaceId===workspaceId&&x.capability===capability);
    if(!grant){grant={id:this.store.id(),workspaceId,capability,enabled,limit:limit??null,updatedAt:new Date()};this.store.state.entitlementGrants.push(grant);}
    else Object.assign(grant,{enabled,limit:limit??null,updatedAt:new Date()});
    return grant;
  }
  get(workspaceId:string, capability:string){return this.store.state.entitlementGrants.find(x=>x.workspaceId===workspaceId&&x.capability===capability);}
  require(workspaceId:string, capability:string){const grant=this.get(workspaceId,capability);if(grant&&!grant.enabled)throw new AppError('FEATURE_NOT_ENTITLED',`${capability} is not enabled for this workspace.`,403);return grant;}
  requireWithinLimit(workspaceId:string,capability:string,current:number){const grant=this.require(workspaceId,capability);if(grant?.limit!=null&&current>=grant.limit)throw new AppError('FEATURE_LIMIT_REACHED',`${capability} limit has been reached.`,409,{limit:grant.limit});return grant;}
}

export class SharedJobService {
  constructor(private readonly store:InMemoryStore){}
  create(input:{workspaceId:string;type:string;principalId:string;idempotencyKey?:string;payload?:Record<string,unknown>;total?:number;maxAttempts?:number;concurrencyKey?:string}){
    const payload=input.payload??{};const requestHash=stableHash(payload);
    if(input.idempotencyKey){const existing=this.store.state.intelligenceJobs.find(x=>x.workspaceId===input.workspaceId&&x.principalId===input.principalId&&x.type===input.type&&x.idempotencyKey===input.idempotencyKey);if(existing){if(existing.requestHash!==requestHash)throw conflict('IDEMPOTENCY_KEY_REUSED','Idempotency key was reused with different input.');return existing;}}
    const key=input.concurrencyKey??input.type;
    if(this.store.state.intelligenceJobs.some(x=>x.workspaceId===input.workspaceId&&x.type===key&&['QUEUED','RUNNING'].includes(x.status)))throw conflict('JOB_CONCURRENCY_LIMIT','Another matching job is already active.');
    const now=new Date();const job:IntelligenceJob={id:this.store.id(),workspaceId:input.workspaceId,type:input.type,principalId:input.principalId,idempotencyKey:input.idempotencyKey??null,requestHash,status:'QUEUED',progress:{processed:0,total:input.total??0,errors:0},checkpoint:null,attempts:0,maxAttempts:input.maxAttempts??5,correlationId:this.store.id(),payload,result:null,error:null,createdAt:now,startedAt:null,completedAt:null,runAt:now};this.store.state.intelligenceJobs.push(job);return job;
  }
  async run<T extends Record<string,unknown>>(jobId:string,worker:(job:IntelligenceJob)=>Promise<T>|T,now=new Date()){
    const job=this.store.state.intelligenceJobs.find(x=>x.id===jobId);if(!job)throw new AppError('JOB_NOT_FOUND','Job was not found.',404);if(job.status==='SUCCEEDED')return job;
    job.status='RUNNING';job.startedAt??=now;job.attempts+=1;
    try{job.result=await worker(job);job.status='SUCCEEDED';job.completedAt=now;job.error=null;}catch(error){job.error=error instanceof Error?error.message:'Unknown job failure';if(job.attempts>=job.maxAttempts){job.status='DEAD_LETTER';job.completedAt=now;}else{job.status='QUEUED';job.runAt=new Date(now.getTime()+Math.min(60_000,1000*2**(job.attempts-1)));}throw error;}return job;
  }
  cancel(actor:ActorContext,id:string){const job=this.store.state.intelligenceJobs.find(x=>x.id===id&&x.workspaceId===actor.workspaceId);if(!job)throw new AppError('JOB_NOT_FOUND','Job was not found.',404);if(['SUCCEEDED','DEAD_LETTER'].includes(job.status))return job;job.status='CANCELLED';job.completedAt=new Date();return job;}
  list(actor:ActorContext){return this.store.state.intelligenceJobs.filter(x=>x.workspaceId===actor.workspaceId);}
}

export class RetentionService {
  constructor(private readonly store:InMemoryStore){}
  register(workspaceId:string,category:string,resourceId:string,expiresAt:Date,legalHold=false){const row={id:this.store.id(),workspaceId,category,resourceId,expiresAt,legalHold,purgedAt:null};this.store.state.retentionRecords.push(row);return row;}
  hold(workspaceId:string,resourceId:string,held=true){const row=this.store.state.retentionRecords.find(x=>x.workspaceId===workspaceId&&x.resourceId===resourceId);if(!row)throw new AppError('RETENTION_RECORD_NOT_FOUND','Retention record was not found.',404);row.legalHold=held;return row;}
  purge(now=new Date()){const purged:string[]=[];for(const row of this.store.state.retentionRecords){if(!row.purgedAt&&!row.legalHold&&row.expiresAt<=now){row.purgedAt=now;purged.push(row.resourceId);const artifact=this.store.state.privateArtifacts.find(x=>x.id===row.resourceId);if(artifact)artifact.content='';}}return purged;}
}

export function audit(store:InMemoryStore, actor:ActorContext|{workspaceId:string;user?:{id:string}}, action:string,entityType:string,entityId:string|null,before?:unknown,after?:unknown,metadata?:unknown){const log={id:store.id(),workspaceId:actor.workspaceId,partnerId:null,actorUserId:actor.user?.id??null,action,entityType,entityId,beforeData:sanitizeAuditPayload(before),afterData:sanitizeAuditPayload(after),metadata:sanitizeAuditPayload(metadata),ipAddress:null,userAgent:null,requestId:null,occurredAt:new Date()};store.state.auditLogs.push(log);return log;}

export function requirePermission(access:{requireScope(actor:ActorContext,key:string):unknown},actor:ActorContext,key:string){try{return access.requireScope(actor,key);}catch{throw forbidden(`${key} permission is required.`);}}

export function spreadsheetSafe(value:unknown){const text=String(value??'');return /^[=+\-@]/.test(text)?`'${text}`:text;}

export function assertSafeUrl(raw:string){let url:URL;try{url=new URL(raw);}catch{throw new AppError('WEBHOOK_TARGET_INVALID','Target URL is invalid.',400);}if(url.protocol!=='https:')throw new AppError('WEBHOOK_TARGET_INVALID','Webhook target must use HTTPS.',400);const host=url.hostname.toLowerCase();if(host==='localhost'||host==='::1'||host.startsWith('127.')||host.startsWith('10.')||host.startsWith('192.168.')||/^172\.(1[6-9]|2\d|3[01])\./.test(host)||host==='169.254.169.254')throw new AppError('WEBHOOK_TARGET_FORBIDDEN','Private and loopback webhook targets are prohibited.',400);return url;}
