import type { InMemoryStore } from '../store';
import type { AccessService } from '../access-service';
import type { CommerceService } from './commerce-service';
import type { ContactCenterService } from './contact-center-service';
import type { FormService } from './form-service';
import type { BackgroundJob } from './types';
import type { ActorContext } from '../access-service';
import { AppError } from '../errors';

/** Executes commercial-pack jobs with deterministic leases, exponential retry and visible dead-letter state. */
export class CommercialBackgroundJobService {
  constructor(
    private readonly store: InMemoryStore,
    private readonly access: AccessService,
    private readonly commerce: CommerceService,
    private readonly forms: FormService,
    private readonly contactCenter: ContactCenterService,
  ) {}

  async runDue(now = new Date(), limit = 25) {
    const due = this.store.state.backgroundJobs
      .filter((job) => job.status === 'PENDING' && job.runAt <= now)
      .sort((a, b) => a.runAt.getTime() - b.runAt.getTime() || a.id.localeCompare(b.id))
      .slice(0, limit);
    const results: Array<{ id: string; status: BackgroundJob['status'] }> = [];
    for (const job of due) {
      job.status = 'RUNNING';
      job.attempts += 1;
      try {
        await this.execute(job);
        job.status = 'SUCCEEDED';
        job.lastError = null;
      } catch (error) {
        job.lastError = error instanceof Error ? error.message : 'Unknown job failure';
        job.failedAt = now;
        const transient = this.isTransient(error);
        job.failureClass = transient ? 'TRANSIENT' : 'PERMANENT';
        if (!transient) job.status = 'FAILED';
        else if (job.attempts >= job.maxAttempts) job.status = 'DEAD_LETTER';
        else {
          job.status = 'PENDING';
          job.runAt = new Date(now.getTime() + Math.min(60_000, 1_000 * 2 ** (job.attempts - 1)));
        }
      }
      results.push({ id: job.id, status: job.status });
    }
    return { claimed: due.length, results };
  }

  retry(jobId: string, now = new Date()) {
    const job = this.store.state.backgroundJobs.find((row) => row.id === jobId);
    if (!job || !['FAILED', 'DEAD_LETTER'].includes(job.status)) throw new Error('JOB_NOT_RETRYABLE');
    job.status = 'PENDING';
    job.attempts = 0;
    job.runAt = now;
    job.lastError = null;
    job.failureClass = null;
    job.failedAt = null;
    return job;
  }

  list(actor:ActorContext){this.access.requireScope(actor,'automation.view_logs');return this.store.state.backgroundJobs.filter(x=>x.workspaceId===actor.workspaceId).sort((a,b)=>b.runAt.getTime()-a.runAt.getTime()||a.id.localeCompare(b.id));}

  retryAs(actor:ActorContext,jobId:string,now=new Date()){this.access.requireScope(actor,'automation.retry');const job=this.store.state.backgroundJobs.find(x=>x.id===jobId&&x.workspaceId===actor.workspaceId);if(!job)throw new AppError('COMMERCIAL_JOB_NOT_FOUND','Commercial job was not found.',404);return this.retry(job.id,now);}

  private isTransient(error:unknown){if(!(error instanceof AppError)&&!(typeof error==='object'&&error!==null&&'status' in error))return true;const status=Number((error as {status?:number}).status??500);return status===408||status===429||status>=500;}

  private async execute(job: BackgroundJob) {
    if (job.type === 'FORM_PROCESS_SUBMISSION') {
      const submission = this.forms.processSubmission(String(job.payload.submissionId));
      if (submission.processingStatus === 'FAILED' || submission.processingStatus === 'PARTIALLY_FAILED') {
        const failure=Object.values(submission.stepOutcomes).find(x=>x.status==='FAILED')?.error;
        if(failure&&failure!=='FORM_CAPTURE_STEP_FAILED')throw new AppError(failure,'Form capture stopped on a permanent business/configuration error.',409);
        throw new Error('FORM_CAPTURE_STEP_FAILED');
      }
      return;
    }
    if(job.type==='FORM_SCAN_UPLOAD'){
      await this.forms.scanUpload(String(job.payload.uploadId));
      return;
    }
    if (job.type === 'CHANNEL_SEND') {
      await this.contactCenter.retryOutbound(String(job.payload.messageId), String(job.payload.connectionId));
      return;
    }
    if (job.type === 'PROVIDER_REFUND') {
      await this.commerce.processProviderRefund(String(job.payload.refundId));
      return;
    }
    if (job.type === 'RECURRING_INVOICE') {
      const user=this.store.state.users.find((row)=>row.id===String(job.payload.actorUserId)&&!row.isDeleted);
      if(!user)throw new AppError('RECURRING_SERVICE_ACTOR_INACTIVE','Recurring service actor is inactive.',409);
      const actor=this.access.actor(user,job.workspaceId);
      this.commerce.runRecurring(actor,String(job.payload.ruleId),String(job.payload.occurrenceKey),new Date(String(job.payload.scheduledFor)));
      return;
    }
    if (job.type === 'SLA_CHECK') {
      this.contactCenter.checkSla(job.runAt);
      return;
    }
    throw new AppError('COMMERCIAL_JOB_TYPE_UNSUPPORTED',`Unsupported commercial job type: ${job.type}`,400);
  }
}
