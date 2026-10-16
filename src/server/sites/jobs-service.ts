import type { PrismaClient } from '@prisma/client';
import { systemEvent } from '../suite/kernel';
import { SitesPublishService } from './publish-service';

/** Sites background jobs: idempotent scheduled releases and TLS certificate provisioning through the hosting provider seam. */
export class SitesJobsService {
  private readonly publisher: SitesPublishService;
  constructor(private readonly db: PrismaClient) { this.publisher = new SitesPublishService(db); }
  tickScheduledReleases(limit = 10) { return this.publisher.tickScheduled(limit); }
  /** Certificates are issued only by a configured managed-hosting TLS provider; otherwise the state remains visible as PENDING. */
  async tickCertificates(limit = 20) {
    const provider = process.env.SITES_TLS_PROVIDER;
    if (!provider) return { issued: 0, blocked: 'SITES_TLS_PROVIDER not configured' };
    const pending = await this.db.siteDomain.findMany({ where: { verificationState: 'VERIFIED', certificateState: 'PENDING' }, take: limit });
    let issued = 0;
    for (const domain of pending) {
      try {
        const response = await fetch(provider.replace(/\/$/, '') + '/certificates', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostname: domain.hostname }), signal: AbortSignal.timeout(20000) });
        const ok = response.ok;
        await this.db.$transaction(async tx => {
          await tx.siteDomain.update({ where: { id: domain.id }, data: { certificateState: ok ? 'CERT_ISSUED' : 'ERROR', verificationState: ok ? 'CERT_ISSUED' : domain.verificationState } });
          await systemEvent(tx, domain.workspaceId, 'SITE', domain.siteId, ok ? 'DOMAIN_CERTIFICATE_ISSUED' : 'DOMAIN_CERTIFICATE_FAILED', { domainId: domain.id });
        });
        if (ok) issued++;
      } catch { /* retried next cycle */ }
    }
    return { issued };
  }
}
