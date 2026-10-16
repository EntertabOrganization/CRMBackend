import type { PrismaClient } from '@prisma/client';
import { MarketingCampaignService } from '../marketing/campaign-service';
import { MarketingDeliveryService } from '../marketing/delivery-service';
import { MarketingGrowthService } from '../marketing/growth-service';
import { HrJobsService } from '../hr/jobs-service';
import { SitesJobsService } from '../sites/jobs-service';

/** Business-suite background work: leased, idempotent, retryable; each tick isolates failures per job family. */
export class SuiteWorkers {
  private readonly campaigns: MarketingCampaignService;
  private readonly deliveries: MarketingDeliveryService;
  private readonly growth: MarketingGrowthService;
  private readonly hr: HrJobsService;
  private readonly sites: SitesJobsService;
  constructor(db: PrismaClient) {
    this.campaigns = new MarketingCampaignService(db); this.deliveries = new MarketingDeliveryService(db); this.growth = new MarketingGrowthService(db);
    this.hr = new HrJobsService(db); this.sites = new SitesJobsService(db);
  }
  async tick() {
    const run = async <T>(name: string, fn: () => Promise<T>) => { try { return await fn(); } catch { process.stderr.write(`Business suite worker ${name} failed; retrying next cycle.\n`); return null; } };
    return {
      marketingSchedules: await run('marketing-schedules', () => this.campaigns.tickSchedules(10)),
      marketingDeliveries: await run('marketing-deliveries', () => this.deliveries.tick(50)),
      marketingAdSync: await run('marketing-ad-sync', () => this.growth.tickAdSync(5)),
      marketingRepeatSales: await run('marketing-repeat-sales', () => this.growth.tickRepeatSales(50)),
      hrAccessTransitions: await run('hr-access', () => this.hr.tickAccessTransitions(20)),
      hrAnomalies: await run('hr-anomalies', () => this.hr.tickAnomalies(100)),
      sitesScheduledReleases: await run('sites-releases', () => this.sites.tickScheduledReleases(10)),
      sitesCertificates: await run('sites-certificates', () => this.sites.tickCertificates(20)),
    };
  }
}
