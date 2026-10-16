import { Module } from '@nestjs/common';
import { prisma } from '../prisma-client';
import { PackRouter } from '../process-platform/http';
import { nestControllers } from '../process-platform/nest-adapter';
import { MarketingAudienceService } from './audience-service';
import { MarketingConsentService } from './consent-service';
import { MarketingChannelService } from './channel-service';
import { MarketingCampaignService } from './campaign-service';
import { MarketingDeliveryService } from './delivery-service';
import { MarketingGrowthService } from './growth-service';

export const marketingAudiences = new MarketingAudienceService(prisma);
export const marketingConsent = new MarketingConsentService(prisma);
export const marketingChannels = new MarketingChannelService(prisma);
export const marketingCampaigns = new MarketingCampaignService(prisma);
export const marketingDeliveries = new MarketingDeliveryService(prisma);
export const marketingGrowth = new MarketingGrowthService(prisma);
const idem = (h: Headers) => h.get('idempotency-key');
const ip = (h: Headers) => h.get('x-real-ip') ?? h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'public';
const M = '/api/v1/marketing';

export const marketingRouter = new PackRouter()
  .add('POST', M + '/segments', 'MarketingSegmentsController', c => marketingAudiences.createSegment(c.actor, c.body), 201)
  .add('GET', M + '/segments', 'MarketingSegmentsController', c => marketingAudiences.listSegments(c.actor, c.query))
  .add('GET', M + '/segments/:id', 'MarketingSegmentsController', c => marketingAudiences.getSegment(c.actor, c.params.id))
  .add('PATCH', M + '/segments/:id', 'MarketingSegmentsController', c => marketingAudiences.patchSegment(c.actor, c.params.id, c.body))
  .add('POST', M + '/segments/:id/preview', 'MarketingSegmentsController', c => marketingAudiences.preview(c.actor, c.params.id))
  .add('POST', M + '/segments/:id/refresh', 'MarketingSegmentsController', c => marketingAudiences.refresh(c.actor, c.params.id))
  .add('POST', M + '/segments/:id/members', 'MarketingSegmentsController', c => marketingAudiences.members(c.actor, c.params.id, c.body, 'ADD'))
  .add('DELETE', M + '/segments/:id/members', 'MarketingSegmentsController', c => marketingAudiences.members(c.actor, c.params.id, c.body, 'REMOVE'))
  .add('GET', M + '/segments/:id/export', 'MarketingSegmentsController', c => marketingAudiences.exportSegment(c.actor, c.params.id))
  .add('POST', M + '/audiences/import-jobs', 'MarketingImportsController', c => marketingAudiences.createImport(c.actor, c.body, idem(c.request.headers)), 202)
  .add('GET', M + '/audiences/import-jobs/:id', 'MarketingImportsController', c => marketingAudiences.getImport(c.actor, c.params.id))
  .add('POST', M + '/audiences/import-jobs/:id/confirm', 'MarketingImportsController', c => marketingAudiences.confirmImport(c.actor, c.params.id))
  .add('GET', M + '/audiences/import-jobs/:id/errors', 'MarketingImportsController', c => marketingAudiences.importErrors(c.actor, c.params.id))
  .add('POST', M + '/audience-identities/:id/link-crm', 'MarketingImportsController', c => marketingAudiences.linkCrm(c.actor, c.params.id, c.body))
  .add('POST', M + '/consents', 'MarketingConsentController', c => marketingConsent.record(c.actor, c.body), 201)
  .add('GET', M + '/consents/history', 'MarketingConsentController', c => marketingConsent.history(c.actor, c.query))
  .add('POST', M + '/consents/withdraw', 'MarketingConsentController', c => marketingConsent.withdraw(c.actor, c.body))
  .add('PUT', M + '/consent-policies', 'MarketingConsentController', c => marketingConsent.policy(c.actor, c.body))
  .add('POST', M + '/suppressions', 'MarketingConsentController', c => marketingConsent.suppress(c.actor, c.body), 201)
  .add('GET', M + '/suppressions', 'MarketingConsentController', c => marketingConsent.suppressions(c.actor, c.query))
  .add('POST', M + '/eligibility/preview', 'MarketingConsentController', c => marketingConsent.preview(c.actor, c.body))
  .add('POST', M + '/providers/connect', 'MarketingProvidersController', c => marketingChannels.connect(c.actor, c.body), 201)
  .add('GET', M + '/providers', 'MarketingProvidersController', c => marketingChannels.list(c.actor))
  .add('GET', M + '/providers/:id/health', 'MarketingProvidersController', c => marketingChannels.health(c.actor, c.params.id))
  .add('POST', M + '/providers/:id/test', 'MarketingProvidersController', c => marketingChannels.providerTest(c.actor, c.params.id, c.body))
  .add('POST', M + '/providers/:id/disable', 'MarketingProvidersController', c => marketingChannels.disable(c.actor, c.params.id))
  .add('POST', M + '/senders', 'MarketingProvidersController', c => marketingChannels.createSender(c.actor, c.body), 201)
  .add('GET', M + '/senders', 'MarketingProvidersController', c => marketingChannels.senders(c.actor))
  .add('POST', M + '/senders/:id/verify', 'MarketingProvidersController', c => marketingChannels.verifySender(c.actor, c.params.id, c.body))
  .add('PATCH', M + '/senders/:id', 'MarketingProvidersController', c => marketingChannels.patchSender(c.actor, c.params.id, c.body))
  .add('POST', M + '/templates', 'MarketingTemplatesController', c => marketingChannels.createTemplate(c.actor, c.body), 201)
  .add('GET', M + '/templates', 'MarketingTemplatesController', c => marketingChannels.templates(c.actor))
  .add('POST', M + '/templates/:id/versions', 'MarketingTemplatesController', c => marketingChannels.createVersion(c.actor, c.params.id, c.body), 201)
  .add('POST', M + '/templates/:id/versions/:version/approve', 'MarketingTemplatesController', c => marketingChannels.approveVersion(c.actor, c.params.id, c.params.version))
  .add('POST', M + '/templates/:id/preview', 'MarketingTemplatesController', c => marketingChannels.preview(c.actor, c.params.id, c.body))
  .add('POST', M + '/campaigns', 'MarketingCampaignsController', c => marketingCampaigns.create(c.actor, c.body), 201)
  .add('GET', M + '/campaigns', 'MarketingCampaignsController', c => marketingCampaigns.list(c.actor, c.query))
  .add('GET', M + '/campaigns/:id', 'MarketingCampaignsController', c => marketingCampaigns.get(c.actor, c.params.id))
  .add('PATCH', M + '/campaigns/:id', 'MarketingCampaignsController', c => marketingCampaigns.patch(c.actor, c.params.id, c.body))
  .add('POST', M + '/campaigns/:id/preview', 'MarketingCampaignsController', c => marketingCampaigns.preview(c.actor, c.params.id))
  .add('POST', M + '/campaigns/:id/submit-approval', 'MarketingCampaignsController', c => marketingCampaigns.submitApproval(c.actor, c.params.id, c.body))
  .add('POST', M + '/campaigns/:id/approve', 'MarketingCampaignsController', c => marketingCampaigns.approve(c.actor, c.params.id, c.body))
  .add('POST', M + '/campaigns/:id/schedule', 'MarketingCampaignsController', c => marketingCampaigns.schedule(c.actor, c.params.id, c.body, idem(c.request.headers)))
  .add('POST', M + '/campaigns/:id/launch', 'MarketingCampaignsController', c => marketingCampaigns.launch(c.actor, c.params.id, c.body, idem(c.request.headers)), 202)
  .add('POST', M + '/campaigns/:id/pause', 'MarketingCampaignsController', c => marketingCampaigns.pause(c.actor, c.params.id))
  .add('POST', M + '/campaigns/:id/resume', 'MarketingCampaignsController', c => marketingCampaigns.resume(c.actor, c.params.id))
  .add('POST', M + '/campaigns/:id/cancel', 'MarketingCampaignsController', c => marketingCampaigns.cancel(c.actor, c.params.id))
  .add('POST', M + '/campaigns/:id/test-send', 'MarketingCampaignsController', c => marketingCampaigns.testSend(c.actor, c.params.id, c.body))
  .add('POST', M + '/campaigns/:id/audience-snapshot', 'MarketingCampaignsController', c => marketingCampaigns.audienceSnapshot(c.actor, c.params.id), 201)
  .add('GET', M + '/campaigns/:id/audience-preview', 'MarketingCampaignsController', c => marketingCampaigns.audiencePreview(c.actor, c.params.id))
  .add('GET', M + '/campaigns/:id/deliveries', 'MarketingDeliveriesController', c => marketingDeliveries.deliveries(c.actor, c.params.id, c.query))
  .add('POST', M + '/campaigns/:id/deliveries/retry-failed', 'MarketingDeliveriesController', c => marketingDeliveries.retryFailed(c.actor, c.params.id))
  .add('GET', M + '/delivery-jobs/:id/logs', 'MarketingDeliveriesController', c => marketingDeliveries.logs(c.actor, c.params.id))
  .add('GET', M + '/campaigns/:id/metrics', 'MarketingAnalyticsController', c => marketingGrowth.metrics(c.actor, c.params.id))
  .add('GET', M + '/campaigns/:id/events', 'MarketingAnalyticsController', c => marketingGrowth.events(c.actor, c.params.id, c.query))
  .add('POST', M + '/campaigns/:id/tracking-links', 'MarketingAnalyticsController', c => marketingGrowth.createTrackingLink(c.actor, c.params.id, c.body), 201)
  .add('POST', M + '/campaigns/:id/conversions', 'MarketingAnalyticsController', c => marketingGrowth.importConversion(c.actor, c.params.id, c.body), 201)
  .add('GET', M + '/reports/conversions', 'MarketingAnalyticsController', c => marketingGrowth.conversionsReport(c.actor, c.query))
  .add('POST', M + '/campaigns/:id/experiments', 'MarketingExperimentsController', c => marketingGrowth.createExperiment(c.actor, c.params.id, c.body), 201)
  .add('GET', M + '/campaigns/:id/experiments/results', 'MarketingExperimentsController', c => marketingGrowth.experimentResults(c.actor, c.params.id))
  .add('POST', M + '/campaigns/:id/experiments/select-winner', 'MarketingExperimentsController', c => marketingGrowth.selectWinner(c.actor, c.params.id, c.body))
  .add('POST', M + '/journeys', 'MarketingJourneysController', c => marketingGrowth.createJourney(c.actor, c.body), 201)
  .add('POST', M + '/journeys/:id/enroll', 'MarketingJourneysController', c => marketingGrowth.enroll(c.actor, c.params.id, c.body, idem(c.request.headers)), 201)
  .add('POST', M + '/journeys/:id/pause', 'MarketingJourneysController', c => marketingGrowth.pauseJourney(c.actor, c.params.id))
  .add('POST', M + '/ad-connections', 'MarketingAdsController', c => marketingGrowth.adConnection(c.actor, c.body), 201)
  .add('POST', M + '/ad-audiences', 'MarketingAdsController', c => marketingGrowth.adAudience(c.actor, c.body), 201)
  .add('POST', M + '/ad-audiences/:id/sync', 'MarketingAdsController', c => marketingGrowth.requestSync(c.actor, c.params.id), 202)
  .add('GET', M + '/ad-audiences/:id/status', 'MarketingAdsController', c => marketingGrowth.audienceStatus(c.actor, c.params.id))
  .add('POST', M + '/ad-metrics/import', 'MarketingAdsController', c => marketingGrowth.importMetrics(c.actor, c.body), 201)
  .add('POST', M + '/repeat-sales/rules', 'MarketingAdsController', c => marketingGrowth.repeatSaleRule(c.actor, c.body), 201);

export const marketingPublicRouter = new PackRouter()
  .addPublic('POST', '/api/v1/public/marketing/unsubscribe', 'MarketingPublicController', c => marketingConsent.unsubscribe(c.body, ip(c.request.headers)))
  .addPublic('GET', '/api/v1/public/marketing/track/:token', 'MarketingPublicController', c => marketingGrowth.track(c.params.token, c.query, ip(c.request.headers), c.request.headers.get('user-agent') ?? ''))
  .addSignedPublic('/api/v1/integrations/marketing/:provider/webhook', 'MarketingProviderWebhookController', c => marketingDeliveries.webhook(c.params.provider, c.request.headers, c.rawBody!));

export class MarketingModule {}
Module({ controllers: [...nestControllers(marketingRouter), ...nestControllers(marketingPublicRouter)] })(MarketingModule);
