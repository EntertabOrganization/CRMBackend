import type { PrismaClient } from '@prisma/client';
import { LEASE_MS } from './support';

/**
 * Atomic, cross-process job claim. One SQL statement moves due PENDING jobs (and RUNNING jobs whose lease expired, i.e. a
 * crashed worker) to RUNNING with a fresh lease; FOR UPDATE SKIP LOCKED guarantees two workers never claim the same job.
 */
export async function claimDueJobsInDb(prisma: PrismaClient, limit: number, workerId: string, now: Date): Promise<string[]> {
  const lease = new Date(now.getTime() + LEASE_MS);
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE "automation_jobs"
       SET "status" = 'RUNNING'::"AutomationJobStatus", "claimed_by" = ${workerId}, "lease_expires_at" = ${lease}, "updated_at" = ${now}
     WHERE "id" IN (
       SELECT "id" FROM "automation_jobs"
        WHERE ("status" = 'PENDING'::"AutomationJobStatus" AND "scheduled_at" <= ${now})
           OR ("status" = 'RUNNING'::"AutomationJobStatus" AND "lease_expires_at" < ${now})
        ORDER BY "scheduled_at", "id"
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
     )
    RETURNING "id"::text AS "id"`;
  return rows.map((row) => row.id);
}
