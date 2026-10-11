import { NextResponse } from 'next/server';
import { appContext } from './app-context';
import { AppError, isAppError } from './errors';
import type { ApiFailure, ApiSuccess, PageMeta } from './domain';
import { claimDueJobsInDb } from './automation/db-claim';
import { hydrateState, persistState } from './persistence';
import { prisma } from './prisma-client';
import { claimCalendarReminders } from './collab/calendar/reminder-delivery';
import { LeaseJobRunner } from './jobs/lease-runner';

export function ok<T>(data: T, meta: PageMeta | null = null) {
  return NextResponse.json<ApiSuccess<T>>({ success: true, data, meta });
}

export function fail(error: unknown, requestId = crypto.randomUUID()) {
  const appError = isAppError(error)
    ? error
    : new AppError('INTERNAL_ERROR', 'Unexpected server error.', 500);

  if (!isAppError(error)) {
    console.error(`[${requestId}] Unhandled route error:`, error);
  }

  return NextResponse.json<ApiFailure>(
    {
      success: false,
      error: {
        code: appError.code,
        message: appError.message,
        details: appError.details,
      },
      requestId,
    },
    { status: appError.status },
  );
}

// Requests share one in-memory working state (hydrate -> mutate -> persist), so they run one at a time. Without this,
// two overlapping requests could see each other's half-finished state.
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

/**
 * Database uniqueness is the last line of defence for invariants the domain also checks (SKU, Variant combination, ...).
 * A violation that slips past the application check is translated into the same stable business error instead of a 500.
 */
function translatePersistError(error: unknown): unknown {
  const candidate = error as { code?: string; meta?: { target?: unknown }; message?: string } | null;
  const collab = translateCollaborationPersistError(candidate);
  if (collab) return collab;
  if (candidate?.code === 'P2034' || /deadlock detected/.test(candidate?.message ?? '')) return new AppError('CONCURRENCY_CONFLICT', 'A concurrent change requires retrying this request.', 409);
  if (candidate?.code === 'P2002') {
    const target = JSON.stringify(candidate.meta?.target ?? '');
    if (target.includes('sku_key')) return new AppError('PRODUCT_SKU_CONFLICT', 'This SKU is already used by another item in the workspace.', 409);
    if (target.includes('axis_key')) return new AppError('VARIANT_COMBINATION_CONFLICT', 'A Variant with this option combination already exists.', 409);
    if (target.includes('idempotency_key') && target.includes('workspace_id')) return new AppError('AUTOMATION_DUPLICATE_JOB', 'The automation job already exists.', 409);
    if (target.includes('commercial_pack_records_invoice_number')) return new AppError('INVOICE_NUMBER_CONFLICT', 'Invoice number was allocated concurrently.', 409);
    if (target.includes('commercial_pack_records_provider_event')) return new AppError('PAYMENT_PROVIDER_EVENT_DUPLICATE', 'Provider event was already processed.', 409);
    if (target.includes('commercial_pack_records_channel_event') || target.includes('commercial_pack_external_message')) return new AppError('CHANNEL_EVENT_DUPLICATE', 'Channel event/message was already processed.', 409);
    if (target.includes('commercial_pack_form_submission_idempotency')) return new AppError('IDEMPOTENCY_KEY_REUSED', 'Submission idempotency key already exists.', 409);
    if (target.includes('commercial_pack_outbound_client_message')) return new AppError('MESSAGE_ALREADY_EXISTS', 'Client message was already accepted.', 409);
    if (target.includes('commercial_pack_')) return new AppError('CONCURRENCY_CONFLICT', 'A concurrent operation changed the same business invariant.', 409);
  }
  return translateDatabaseError(error);
}

/**
 * Collaboration-module database guards (version trigger, dependency-cycle trigger, deferrable exclusion constraints and
 * unique keys) fire only when another application instance won a race; they map to the same codes the services use.
 */
function translateCollaborationPersistError(candidate: { code?: string; meta?: { target?: unknown }; message?: string } | null): AppError | null {
  const text = `${candidate?.message ?? ''} ${JSON.stringify(candidate?.meta ?? {})}`;
  if (text.includes('CHAT_MEMBERSHIP_SOURCE_PROTECTED')) return new AppError('CHAT_MEMBERSHIP_SOURCE_PROTECTED', 'Membership is managed by its owning resource.', 409);
  if (text.includes('CHAT_MEMBER_INVALID')) return new AppError('CHAT_MEMBER_INVALID', 'Chat membership is invalid.', 400);
  if (candidate?.code === 'P2002' && /"modelName":"(?:ChatMessage|ChatReadState|ChatDraft|ChatMessageReaction|ChatMessagePin|ChatMessageFavorite|ChatMessageRead)"/.test(text))
    return new AppError('CONCURRENCY_CONFLICT', 'This Chat changed concurrently. Retry the request.', 409);
  if (text.includes('CHAT_MESSAGE_IMMUTABLE')) return new AppError('CHAT_MESSAGE_IMMUTABLE', 'Message history cannot be changed.', 409);
  if (text.includes('CHAT_MESSAGE_INVALID')) return new AppError('CHAT_MESSAGE_INVALID', 'The Message or its Chat changed concurrently.', 409);
  if (text.includes('CHAT_READ_POSITION_INVALID')) return new AppError('CHAT_READ_POSITION_INVALID', 'Read positions only move forward.', 409);
  if (candidate?.code === 'P2002' && /"modelName":"(?:GeneratedDocument|DocumentTemplateRevision)"/.test(text))
    return new AppError('CONCURRENCY_CONFLICT', 'The document request was committed concurrently. Retry with the same generationKey.', 409);
  if (text.includes('DOCUMENT_GENERATION_DUPLICATE')) return new AppError('DOCUMENT_GENERATION_DUPLICATE', 'This document number is already held by a ready document.', 409);
  if (text.includes('DOCUMENT_TEMPLATE_REVISION_IMMUTABLE') || text.includes('DOCUMENT_TEMPLATE_IMMUTABLE') || text.includes('GENERATED_DOCUMENT_IMMUTABLE'))
    return new AppError('DOCUMENT_HISTORY_IMMUTABLE', 'Published template revisions and generated documents cannot be changed.', 409);
  if (text.includes('DOCUMENT_TEMPLATE_INVALID')) return new AppError('DOCUMENT_TEMPLATE_INVALID', 'The template changed concurrently.', 409);
  if (text.includes('DOCUMENT_GENERATION_FAILED')) return new AppError('DOCUMENT_GENERATION_FAILED', 'The document could not be published.', 409);
  if (text.includes('FOLDER_HIERARCHY_CYCLE')) return new AppError('FOLDER_HIERARCHY_CYCLE', 'Folder hierarchy changes cannot create a cycle.', 409);
  if (text.includes('FOLDER_NOT_FOUND')) return new AppError('FOLDER_NOT_FOUND', 'Folder was not found.', 404);
  if (text.includes('FILE_PERMISSION_INVALID')) return new AppError('FILE_PERMISSION_INVALID', 'File permission subjects and resources must belong to this Workspace.', 400);
  if (text.includes('FILE_VERSION_IMMUTABLE')) return new AppError('FILE_VERSION_IMMUTABLE', 'Historical File content cannot be changed.', 409);
  if (text.includes('UPLOAD_SESSION_STATE_INVALID')) return new AppError('UPLOAD_SESSION_STATE_INVALID', 'This Upload Session cannot be changed in that way.', 409);
  if (text.includes('UPLOAD_SESSION_NOT_FOUND')) return new AppError('UPLOAD_SESSION_NOT_FOUND', 'Upload Session was not found.', 404);
  if (text.includes('FILE_VERSION_INVALID')) return new AppError('FILE_VERSION_INVALID', 'File and current Version must be consistent.', 409);
  if (text.includes('FILE_QUOTA_POLICY_INVALID')) return new AppError('FILE_QUOTA_POLICY_INVALID', 'The effective File quota policy is invalid.', 409);
  if (text.includes('FILE_TOO_LARGE')) return new AppError('FILE_TOO_LARGE', 'File size exceeds the effective single-file limit.', 413);
  if (text.includes('STORAGE_QUOTA_EXCEEDED')) return new AppError('STORAGE_QUOTA_EXCEEDED', 'The Workspace storage quota would be exceeded.', 409);
  if (/drive_file_sibling_name/.test(text)) return new AppError('FILE_NAME_CONFLICT', 'A File with this name already exists in the destination.', 409);
  if (text.includes('FILE_DELIVERY_UNAVAILABLE')) return new AppError('FILE_DELIVERY_UNAVAILABLE', 'This delivery path is unavailable.', 410);
  if (text.includes('FILE_LOCKED') || text.includes('file_locks_exclusive')) return new AppError('FILE_LOCKED', 'The File has an active exclusive lease.', 409);
  if (text.includes('EDIT_SESSION_EXPIRED')) return new AppError('EDIT_SESSION_EXPIRED', 'The edit lease has expired.', 410);
  if (text.includes('FILE_NOT_EDITABLE')) return new AppError('FILE_NOT_EDITABLE', 'This File is not available for editing.', 409);
  if (text.includes('ATTACHMENT_CROSS_WORKSPACE')) return new AppError('ATTACHMENT_CROSS_WORKSPACE', 'The attachment references are inaccessible.', 400);
  if (text.includes('ATTACHMENT_ENTITY_ACCESS_DENIED')) return new AppError('ATTACHMENT_ENTITY_ACCESS_DENIED', 'The owning record is inaccessible.', 403);
  if (text.includes('PUBLIC_LINK_REVOKED')) return new AppError('PUBLIC_LINK_REVOKED', 'This public link is unavailable.', 410);
  if (text.includes('PUBLIC_LINK_DOWNLOAD_LIMIT')) return new AppError('PUBLIC_LINK_DOWNLOAD_LIMIT', 'This public link is unavailable.', 410);
  if (text.includes('PUBLIC_LINK_NOT_FOUND')) return new AppError('PUBLIC_LINK_NOT_FOUND', 'Public link was not found.', 404);
  if (text.includes('FILE_RETENTION_HOLD')) return new AppError('FILE_RETENTION_HOLD', 'The folder subtree is protected by retention or a legal hold.', 409);
  if (candidate?.code === 'P2002' && /file_folder_sibling_name/.test(text)) return new AppError('FOLDER_NAME_CONFLICT', 'An active sibling already uses this name.', 409);
  if (candidate?.code === 'P2002' && /file_storage_(?:personal|company)_canonical/.test(text)) return new AppError('STORAGE_ALREADY_EXISTS', 'This canonical storage already exists.', 409);
  if (candidate?.code === 'P2002' && /"modelName":"(?:DirectChatPair|CollaborationChat)"/.test(text)) return new AppError('CONCURRENCY_CONFLICT', 'This canonical Chat was created concurrently. Retry the request.', 409);
  if (text.includes('RESOURCE_VERSION_CONFLICT')) return new AppError('RESOURCE_VERSION_CONFLICT', 'The resource was changed by someone else. Reload and retry.', 409);
  if (text.includes('CALENDAR_PERMISSION_INVALID')) return new AppError('CALENDAR_PERMISSION_INVALID', 'Calendar permission subjects must belong to this Workspace.', 400);
  if (text.includes('CALENDAR_USER_TENANT_INVALID')) return new AppError('CALENDAR_INVALID_OWNER', 'Calendar users must belong to this Workspace.', 400);
  if (text.includes('EVENT_ATTENDEE_INVALID')) return new AppError('EVENT_ATTENDEE_INVALID', 'Event users must belong to this Workspace.', 400);
  if (text.includes('EVENT_BINDING_INVALID')) return new AppError('EVENT_BINDING_INVALID', 'Event binding targets must belong to this Workspace.', 400);
  if (text.includes('RECURRENCE_SCOPE_INVALID')) return new AppError('RECURRENCE_SCOPE_INVALID', 'Recurrence links or value types are invalid.', 400);
  if (text.includes('calendar_resource_booking_exclusive')) return new AppError('RESOURCE_BOOKING_CONFLICT', 'The resource is already reserved for this interval.', 409);
  if (text.includes('RESOURCE_INACTIVE')) return new AppError('RESOURCE_INACTIVE', 'The resource is inactive.', 409);
  if (text.includes('RESOURCE_CAPACITY_INVALID')) return new AppError('RESOURCE_CAPACITY_INVALID', 'The Event exceeds resource capacity.', 400);
  if (text.includes('RESOURCE_NOT_FOUND')) return new AppError('RESOURCE_NOT_FOUND', 'Resource was not found.', 404);
  if (text.includes('AVAILABILITY_INVALID_RANGE')) return new AppError('AVAILABILITY_INVALID_RANGE', 'The working schedule or query range is invalid.', 400);
  if (text.includes('AVAILABILITY_SUBJECT_NOT_FOUND')) return new AppError('AVAILABILITY_SUBJECT_NOT_FOUND', 'Availability subject was not found.', 404);
  if (text.includes('BOOKING_PAGE_NOT_FOUND')) return new AppError('BOOKING_PAGE_NOT_FOUND', 'Booking page was not found.', 404);
  if (text.includes('BOOKING_PAGE_INVALID')) return new AppError('BOOKING_PAGE_INVALID', 'The booking page configuration is invalid.', 400);
  if (/BOOKING_SLOT_UNAVAILABLE|calendar_booking_host_exclusive/.test(text)) return new AppError('BOOKING_SLOT_UNAVAILABLE', 'The requested slot is unavailable. Reload availability and retry.', 409);
  if (text.includes('BOOKING_EVENT_MANAGED')) return new AppError('BOOKING_EVENT_MANAGED', 'Change this Event through its Booking.', 409);
  if (text.includes('BOOKING_STATE_INVALID')) return new AppError('BOOKING_STATE_INVALID', 'The Booking state or identity is invalid.', 409);
  if (text.includes('FILE_OBJECT_RETIRED')) return new AppError('FILE_OBJECT_RETIRED', 'This immutable object has been retired.', 409);
  if (text.includes('FILE_OBJECT_CLEANUP_UNSAFE')) return new AppError('FILE_OBJECT_CLEANUP_UNSAFE', 'Content cannot be safely cleaned up.', 409);
  if (candidate?.code === 'P2002' && /"modelName":"CalendarBooking"/.test(text)) return new AppError('BOOKING_IDEMPOTENCY_CONFLICT', 'This Booking request was committed concurrently. Retry with the same request ID.', 409);
  if (candidate?.code === 'P2002' && /"modelName":"CalendarBookingPageRules"/.test(text)) return new AppError('RESOURCE_VERSION_CONFLICT', 'Booking page rules changed concurrently. Reload and retry.', 409);
  if (candidate?.code === 'P2002' && /calendar_booking_pages_slug|"modelName":"CalendarBookingPage"/.test(text)) return new AppError('BOOKING_PAGE_SLUG_CONFLICT', 'This public address is unavailable.', 409);
  if (candidate?.code === 'P2002' && /"modelName":"(?:BusinessCalendar|UserWorkingSchedule)"/.test(text)) return new AppError('RESOURCE_VERSION_CONFLICT', 'The working schedule changed concurrently. Reload and retry.', 409);
  if (candidate?.code === 'P2002' && /"modelName":"CalendarAvailabilityRebuild"/.test(text)) return new AppError('RESOURCE_VERSION_CONFLICT', 'Availability work was queued concurrently. Retry the query.', 409);
  if (candidate?.code === 'P2002' && /calendar_recurrence_rules_one_live_event|"modelName":"CalendarRecurrence(?:Rule|Exception|Range)"/.test(text)) return new AppError('RESOURCE_VERSION_CONFLICT', 'The recurrence was changed concurrently. Reload and retry.', 409);
  if (candidate?.code === 'P2002' && /"modelName":"MeetingRecord"/.test(text)) return new AppError('RESOURCE_VERSION_CONFLICT', 'The meeting record was changed concurrently. Reload and retry.', 409);
  if (candidate?.code === 'P2002' && /"modelName":"IdempotencyRecord"/.test(text)) return new AppError('RESOURCE_VERSION_CONFLICT', 'This request was committed concurrently. Retry with the same idempotency key.', 409);
  if (candidate?.code === 'P2002' && /calendars_project_id_key|"modelName":"Calendar"/.test(text)) return new AppError('CALENDAR_PROJECT_EXISTS', 'This Project already has a canonical Calendar.', 409);
  if (candidate?.code === 'P2002' && /"modelName":"UserCalendarPreference"/.test(text)) return new AppError('RESOURCE_VERSION_CONFLICT', 'The preference was changed by someone else. Reload and retry.', 409);
  if (candidate?.code === 'P2002' && /"modelName":"CalendarPermission"/.test(text)) return new AppError('CALENDAR_PERMISSION_INVALID', 'Calendar permission subjects must be unique.', 400);
  if (text.includes('TASK_DEPENDENCY_CYCLE')) return new AppError('TASK_DEPENDENCY_CYCLE', 'The dependency would create a cycle.', 409);
  if (text.includes('TASK_DEPENDENCY_SELF')) return new AppError('TASK_DEPENDENCY_SELF', 'A Task cannot depend on itself.', 400);
  if (text.includes('task_time_entries_one_active_timer_excl')) return new AppError('TIME_ENTRY_ACTIVE_TIMER_EXISTS', 'A timer is already running for this Task.', 409);
  if (text.includes('project_members_single_owner_excl')) return new AppError('PROJECT_OWNER_TRANSFER_INVALID', 'Project ownership changed concurrently.', 409);
  if (text.includes('project_stages_code_excl')) return new AppError('PROJECT_STAGE_CODE_CONFLICT', 'Another stage already uses this code.', 409);
  if (text.includes('project_stages_default_excl')) return new AppError('CONCURRENCY_CONFLICT', 'The default stage changed concurrently.', 409);
  if (candidate?.code === 'P2002') {
    const target = JSON.stringify(candidate.meta?.target ?? '');
    if (/recurrence_rule_id|recurrenceRuleId/.test(target)) return new AppError('RECURRENCE_DUPLICATE_INSTANCE', 'This occurrence was already generated.', 409);
    if (/predecessor_task_id|predecessorTaskId/.test(target)) return new AppError('TASK_DEPENDENCY_DUPLICATE', 'This dependency already exists.', 409);
    if (/projects_workspace_id_code|"code"/.test(target) && /workspace/.test(target)) return new AppError('PROJECT_CODE_CONFLICT', 'Another Project already uses this code.', 409);
  }
  return null;
}

/** Converts unavailable/missing PostgreSQL failures into a stable, sanitized API contract. */
export function translateDatabaseError(error: unknown): unknown {
  const candidate = error as { code?: string; name?: string; message?: string } | null;
  const unavailableCodes = new Set(['P1000', 'P1001', 'P1002', 'P1003', 'P1017']);
  if (
    (candidate?.code && unavailableCodes.has(candidate.code)) ||
    candidate?.name === 'PrismaClientInitializationError' ||
    /can't reach database server|server has closed the connection/i.test(candidate?.message ?? '')
  ) {
    return new AppError('DATABASE_UNAVAILABLE', 'The database is temporarily unavailable.', 503);
  }
  return error;
}

async function withState<T>(handler: () => Promise<T>): Promise<{ result?: T; error?: unknown }> {
  let snapshot;
  try {
    snapshot = await hydrateState(prisma);
  } catch (error) {
    return { error: translateDatabaseError(error) };
  }
  appContext.store.state = structuredClone(snapshot);
  appContext.realtime.discard();
  let committed = false;
  let outcome: { result?: T; error?: unknown };
  try {
    const result = await handler();
    try {
      // Timeline is projected from the outbox events this request just wrote, in the same transaction.
      appContext.timeline.projectPending();
    } catch (projectionError) {
      // A projection failure must never fail the business operation; the events stay unprojected and are retried.
      console.error('Timeline projection failed:', projectionError);
    }
    try {
      // Automation matches the new events against active Rules and only records durable jobs here (no side effects);
      // the jobs run afterwards in their own transactions. A failure leaves the events unprocessed for a later retry.
      appContext.automation.ingestPending();
    } catch (ingestError) {
      console.error('Automation ingestion failed:', ingestError);
    }
    committed = true;
    outcome = { result };
  } catch (error) {
    outcome = { error };
  }
  if (committed) {
    try {
      await persistState(prisma, snapshot, appContext.store.state);
    } catch (persistError) {
      committed = false;
      appContext.store.state = structuredClone(snapshot);
      outcome = { error: translatePersistError(persistError) };
    }
  } else {
    // A failed handler is a failed transaction. Never persist mutations that
    // happened before validation/provider failure, and do not leave them in the
    // shared working state for the next request.
    appContext.store.state = structuredClone(snapshot);
  }
  // Advisory hints are released only after the commit, and only for successful requests.
  if (committed) appContext.realtime.flush();
  else appContext.realtime.discard();
  return outcome;
}

/** Runs a read-only handler against freshly hydrated state (nothing is persisted or projected). */
export function readOnly<T>(handler: () => Promise<T>): Promise<{ result?: T; error?: unknown }> {
  return serialized(async () => {
    let snapshot;
    try {
      snapshot = await hydrateState(prisma);
    } catch (error) {
      return { error: translateDatabaseError(error) };
    }
    appContext.store.state = structuredClone(snapshot);
    try {
      return { result: await handler() };
    } catch (error) {
      return { error };
    }
  });
}

export function route<T>(handler: () => Promise<T>, meta: PageMeta | null = null) {
  return serialized(async () => {
    const outcome = await withState(handler);
    if (!('error' in outcome)) kickAutomationRunner();
    return 'error' in outcome ? fail(outcome.error) : ok(outcome.result as T, meta);
  });
}

export function routeWithMeta<T>(handler: () => Promise<{ data: T; meta: PageMeta | Record<string, unknown> | null }>) {
  return serialized(async () => {
    const outcome = await withState(handler);
    if ('error' in outcome) return fail(outcome.error);
    const value = outcome.result!;
    return ok(value.data, value.meta as PageMeta | null);
  });
}

// ---- Automation background work ---------------------------------------------------------------------------------------------

/** Runs one unit of system work (an Automation step) in its own hydrate -> run -> commit transaction and rethrows its error. */
export function runStateUnit<T>(handler: () => Promise<T> | T): Promise<T> {
  return serialized(async () => {
    const outcome = await withState(async () => handler());
    if ('error' in outcome) throw outcome.error;
    return outcome.result as T;
  });
}

const dbStateRunner = {
  unit: runStateUnit,
  claimDue: (limit: number, workerId: string, now: Date) => claimDueJobsInDb(prisma, limit, workerId, now),
};

function useDbRunner() {
  appContext.automation.setStateRunner(dbStateRunner);
  return appContext.automation.runner;
}

/** Claims and runs due Automation jobs (scheduler endpoint / optional inline runner). */
export async function runAutomationDue(limit = 25) {
  return useDbRunner().runDue({ limit });
}
/** Abort/expiry is committed before private multipart objects are removed. */
export async function runUploadCleanup(limit = 25) {
  return new LeaseJobRunner(appContext.collab.files.uploadCleanup, { unit: runStateUnit }).runDue({ limit });
}
export async function runFileObjectGarbage(limit = 25) {
  return new LeaseJobRunner(appContext.collab.files.objectGarbage, { unit: runStateUnit }).runDue({ limit });
}
export async function runDocumentEditCleanup(limit = 25) {
  return new LeaseJobRunner(appContext.collab.editingCleanup, { unit: runStateUnit }).runDue({ limit });
}
/** Generated documents render and scan outside state units; publication re-proves authority under a durable lease. */
export async function runDocumentGeneration(limit = 25) {
  return new LeaseJobRunner(appContext.collab.documents.generated, { unit: runStateUnit }).runDue({ limit });
}
/** Accepted immutable bytes are processed outside state transactions; verdicts commit under a durable lease. */
export async function runUploadProcessing(limit = 25) {
  return new LeaseJobRunner(appContext.collab.files.uploadProcessing, { unit: runStateUnit }).runDue({ limit });
}
/** Calendar reminder leases commit before provider I/O. Provider idempotency keys survive worker crashes. */
export async function runCalendarReminders(limit = 25, now?: Date) {
  await runStateUnit(() => {
    appContext.collab.calendar.reminders.materialize(now ?? new Date());
    appContext.collab.calendar.reminderDelivery.expireExhausted(now ?? new Date());
  });
  return appContext.collab.calendar.reminderRunner({ unit: runStateUnit,
    claimDue: (count, token, at) => claimCalendarReminders(prisma, count, token, at),
  }).runDue({ limit, now });
}

/** Each availability page commits separately; competing processes are fenced by the durable row version. */
export async function runCalendarAvailability(limit = 25) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AppError('VALIDATION_ERROR', 'limit must be an integer between 1 and 100.', 400);
  const metrics = { processed: 0, ready: 0, failed: 0, cancelled: 0, skipped: 0 };
  for (let page = 0; page < limit; page += 1) {
    try {
      const result = await runStateUnit(() => appContext.collab.calendar.availabilityRebuilds.runOne());
      if (!result) break;
      metrics.processed += 1;
      if (result.status === 'READY') metrics.ready += 1;
      if (result.status === 'FAILED') metrics.failed += 1;
      if (result.status === 'CANCELLED') metrics.cancelled += 1;
    } catch (error) {
      if (!(error instanceof AppError) || !['RESOURCE_VERSION_CONFLICT', 'CONCURRENCY_CONFLICT'].includes(error.code)) throw error;
      metrics.skipped += 1;
    }
  }
  return metrics;
}

/** Runs one specific pending job now (manual execution). Returns the execution id when a run happened. */
export async function runAutomationJob(jobId: string): Promise<string | null> {
  const runner = useDbRunner();
  const claimed = await runStateUnit(() => {
    const job = appContext.automation.support.state.automationJobs.find((item) => item.id === jobId);
    if (!job || job.status !== 'PENDING') return false;
    job.status = 'RUNNING';
    job.claimedBy = 'manual';
    job.leaseExpiresAt = new Date(Date.now() + 5 * 60_000);
    return true;
  });
  return claimed ? runner.runJob(jobId) : null;
}

let inlineRunnerActive = false;

/**
 * Optional in-process worker (AUTOMATION_INLINE_RUNNER=1): after a request commits, due jobs are run in the background.
 * Production deployments normally drive jobs through POST /api/v1/internal/crm/jobs/automation-run instead.
 */
export function kickAutomationRunner() {
  if (process.env.AUTOMATION_INLINE_RUNNER !== '1' || inlineRunnerActive) return;
  if (!appContext.automation.hasWork()) return;
  inlineRunnerActive = true;
  setImmediate(() => {
    runAutomationDue()
      .catch((error) => console.error('Inline automation runner failed:', error))
      .finally(() => {
        inlineRunnerActive = false;
      });
  });
}
