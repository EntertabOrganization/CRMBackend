import type { PrismaClient } from '@prisma/client';
import './register';
import { PlatformEventService, PlatformJobService } from './events-service';
import { PlatformNotificationService } from './notifications-service';

/** Platform background work: outbox dispatch, durable jobs, schedules and notification delivery. */
export class PlatformWorkers {
  private readonly events: PlatformEventService;
  private readonly jobs: PlatformJobService;
  private readonly notifications: PlatformNotificationService;
  constructor(db: PrismaClient) { this.events = new PlatformEventService(db); this.jobs = new PlatformJobService(db); this.notifications = new PlatformNotificationService(db); }
  async tick() {
    const run = async <T>(name: string, fn: () => Promise<T>) => { try { return await fn(); } catch { process.stderr.write(`Platform worker ${name} failed; retrying next cycle.\n`); return null; } };
    return {
      platformSchedules: await run('schedules', () => this.jobs.tickSchedules()),
      platformEvents: await run('events', () => this.events.tick(50)),
      platformJobs: await run('jobs', () => this.jobs.tick(20)),
      platformNotifications: await run('notifications', () => this.notifications.tickDeliveries(50)),
    };
  }
}
