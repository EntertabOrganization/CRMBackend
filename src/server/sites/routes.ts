import { Module } from '@nestjs/common';
import { prisma } from '../prisma-client';
import { PackRouter } from '../process-platform/http';
import { nestControllers } from '../process-platform/nest-adapter';
import { SitesSiteService } from './site-service';
import { SitesContentService } from './content-service';
import { SitesPublishService } from './publish-service';
import { SitesExperienceService } from './experience-service';

export const sitesSites = new SitesSiteService(prisma);
export const sitesContent = new SitesContentService(prisma);
export const sitesPublisher = new SitesPublishService(prisma);
export const sitesExperience = new SitesExperienceService(prisma, sitesContent, sitesPublisher);
const idem = (h: Headers) => h.get('idempotency-key');
const ip = (h: Headers) => h.get('x-real-ip') ?? h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'public';
const S = '/api/v1/sites';

export const sitesRouter = new PackRouter()
  .add('POST', S, 'SitesController', c => sitesSites.create(c.actor, c.body), 201)
  .add('GET', S, 'SitesController', c => sitesSites.list(c.actor, c.query))
  .add('GET', S + '/blocks/catalog', 'SitesBlocksController', async () => sitesContent.blockCatalog())
  .add('GET', S + '/templates', 'SitesBlocksController', async () => sitesContent.templates())
  .add('POST', S + '/shared-blocks', 'SitesBlocksController', c => sitesContent.createSharedBlock(c.actor, c.body), 201)
  .add('POST', S + '/shared-blocks/:id/revisions', 'SitesBlocksController', c => sitesContent.sharedBlockRevision(c.actor, c.params.id, c.body), 201)
  .add('POST', S + '/shared-blocks/:id/publish', 'SitesBlocksController', c => sitesContent.publishSharedBlock(c.actor, c.params.id, c.body))
  .add('POST', S + '/domains/:id/verify', 'SitesDomainsController', c => sitesSites.verifyDomain(c.actor, c.params.id))
  .add('PATCH', S + '/pages/:id', 'SitesPagesController', c => sitesContent.patchPage(c.actor, c.params.id, c.body))
  .add('POST', S + '/pages/:id/revisions', 'SitesPagesController', c => sitesContent.createRevision(c.actor, c.params.id, c.body), 201)
  .add('POST', S + '/pages/:id/blocks', 'SitesPagesController', c => sitesContent.addBlock(c.actor, c.params.id, c.body), 201)
  .add('PATCH', S + '/pages/:id/blocks/:blockId', 'SitesPagesController', c => sitesContent.addBlock(c.actor, c.params.id, c.body, c.params.blockId))
  .add('POST', S + '/pages/:id/archive', 'SitesPagesController', c => sitesContent.archivePage(c.actor, c.params.id, c.body))
  .add('POST', S + '/pages/:id/restore', 'SitesPagesController', c => sitesContent.restorePage(c.actor, c.params.id))
  .add('PUT', S + '/pages/:id/seo', 'SitesSeoController', c => sitesExperience.pageSeo(c.actor, c.params.id, c.body))
  .add('POST', S + '/pages/:id/translations', 'SitesLocalizationController', c => sitesExperience.translate(c.actor, c.params.id, c.body), 201)
  .add('POST', S + '/translations/:id/review', 'SitesLocalizationController', c => sitesExperience.reviewTranslation(c.actor, c.params.id, c.body))
  .add('POST', S + '/pages/:id/module-bindings', 'SitesModulesController', c => sitesExperience.bind(c.actor, c.params.id, c.body), 201)
  .add('PATCH', S + '/module-bindings/:id', 'SitesModulesController', c => sitesExperience.patchBinding(c.actor, c.params.id, c.body))
  .add('POST', S + '/scripts/:id/approve', 'SitesScriptsController', c => sitesExperience.decideScript(c.actor, c.params.id, c.body))
  .add('POST', S + '/pages/:id/experiments', 'SitesExperimentsController', c => sitesExperience.createExperiment(c.actor, c.params.id, c.body), 201)
  .add('POST', S + '/experiments/:id/activate', 'SitesExperimentsController', c => sitesExperience.experimentState(c.actor, c.params.id, 'RUNNING'))
  .add('POST', S + '/experiments/:id/stop', 'SitesExperimentsController', c => sitesExperience.experimentState(c.actor, c.params.id, 'STOPPED'))
  .add('GET', S + '/experiments/:id/results', 'SitesExperimentsController', c => sitesExperience.experimentResults(c.actor, c.params.id))
  .add('POST', S + '/pages/:id/ai/rewrite', 'SitesAiController', async c => { const page = await prisma.sitePage.findFirst({ where: { workspaceId: c.actor.workspaceId, id: c.params.id } }); return sitesExperience.generate(c.actor, page?.siteId ?? '00000000-0000-0000-0000-000000000000', c.body, c.params.id); }, 201)
  .add('POST', S + '/ai-drafts/:id/accept', 'SitesAiController', c => sitesExperience.decideDraft(c.actor, c.params.id, 'ACCEPTED'))
  .add('POST', S + '/ai-drafts/:id/reject', 'SitesAiController', c => sitesExperience.decideDraft(c.actor, c.params.id, 'REJECTED'))
  .add('GET', S + '/ai-drafts/:id/usage', 'SitesAiController', c => sitesExperience.usage(c.actor, c.params.id))
  .add('POST', S + '/revisions/:id/approve', 'SitesPublishController', c => sitesPublisher.approveRevision(c.actor, c.params.id))
  .add('GET', S + '/:id', 'SitesController', c => sitesSites.get(c.actor, c.params.id))
  .add('PATCH', S + '/:id', 'SitesController', c => sitesSites.patch(c.actor, c.params.id, c.body))
  .add('POST', S + '/:id/domains', 'SitesDomainsController', c => sitesSites.addDomain(c.actor, c.params.id, c.body), 201)
  .add('POST', S + '/:id/unpublish', 'SitesController', c => sitesSites.unpublish(c.actor, c.params.id, c.body))
  .add('GET', S + '/:id/hosting-status', 'SitesDomainsController', c => sitesSites.hostingStatus(c.actor, c.params.id))
  .add('POST', S + '/:id/archive', 'SitesController', c => sitesSites.archive(c.actor, c.params.id, c.body))
  .add('POST', S + '/:id/restore', 'SitesController', c => sitesSites.restore(c.actor, c.params.id))
  .add('POST', S + '/:id/export', 'SitesController', c => sitesSites.exportSite(c.actor, c.params.id, c.body), 202)
  .add('GET', S + '/:id/entitlement-impact', 'SitesController', c => sitesSites.entitlementImpact(c.actor, c.params.id))
  .add('POST', S + '/:id/pages', 'SitesPagesController', c => sitesContent.createPage(c.actor, c.params.id, c.body), 201)
  .add('GET', S + '/:id/pages', 'SitesPagesController', c => sitesContent.listPages(c.actor, c.params.id))
  .add('POST', S + '/:id/folders', 'SitesPagesController', c => sitesContent.folder(c.actor, c.params.id, c.body), 201)
  .add('POST', S + '/:id/navigation', 'SitesPagesController', c => sitesContent.navigation(c.actor, c.params.id, c.body))
  .add('PUT', S + '/:id/redirects', 'SitesPagesController', c => sitesContent.redirects(c.actor, c.params.id, c.body))
  .add('POST', S + '/:id/redirects-from-deleted', 'SitesPagesController', c => sitesContent.redirectsFromDeleted(c.actor, c.params.id, c.body))
  .add('POST', S + '/:id/content', 'SitesPagesController', c => sitesContent.contentEntry(c.actor, c.params.id, c.body), 201)
  .add('POST', S + '/:id/theme', 'SitesBlocksController', c => sitesContent.theme(c.actor, c.params.id, c.body), 201)
  .add('POST', S + '/:id/from-template', 'SitesBlocksController', c => sitesContent.fromTemplate(c.actor, c.params.id, c.body), 201)
  .add('POST', S + '/:id/preview-links', 'SitesPublishController', c => sitesPublisher.previewLink(c.actor, c.params.id, c.body), 201)
  .add('POST', S + '/:id/preview-links/:previewId/revoke', 'SitesPublishController', c => sitesPublisher.revokePreview(c.actor, c.params.id, c.params.previewId))
  .add('GET', S + '/:id/releases', 'SitesPublishController', c => sitesPublisher.releases(c.actor, c.params.id))
  .add('POST', S + '/:id/releases/preview', 'SitesPublishController', c => sitesPublisher.previewRelease(c.actor, c.params.id), 201)
  .add('POST', S + '/:id/releases/submit-approval', 'SitesPublishController', c => sitesPublisher.submitApproval(c.actor, c.params.id, c.body))
  .add('POST', S + '/:id/releases/:releaseId/approve', 'SitesPublishController', c => sitesPublisher.approve(c.actor, c.params.id, c.params.releaseId, c.body))
  .add('POST', S + '/:id/releases/publish', 'SitesPublishController', c => sitesPublisher.publish(c.actor, c.params.id, c.body, idem(c.request.headers)))
  .add('POST', S + '/:id/releases/schedule', 'SitesPublishController', c => sitesPublisher.schedule(c.actor, c.params.id, c.body, idem(c.request.headers)))
  .add('POST', S + '/:id/releases/:releaseId/rollback', 'SitesPublishController', c => sitesPublisher.rollback(c.actor, c.params.id, c.params.releaseId, idem(c.request.headers)))
  .add('POST', S + '/:id/languages', 'SitesLocalizationController', c => sitesExperience.addLanguage(c.actor, c.params.id, c.body), 201)
  .add('PATCH', S + '/:id/languages/:locale', 'SitesLocalizationController', c => sitesExperience.patchLanguage(c.actor, c.params.id, c.params.locale, c.body))
  .add('GET', S + '/:id/localization-coverage', 'SitesLocalizationController', c => sitesExperience.coverage(c.actor, c.params.id))
  .add('GET', S + '/:id/seo', 'SitesSeoController', c => sitesExperience.siteSeo(c.actor, c.params.id))
  .add('PATCH', S + '/:id/seo', 'SitesSeoController', c => sitesExperience.siteSeo(c.actor, c.params.id, c.body))
  .add('POST', S + '/:id/sitemap/rebuild', 'SitesSeoController', c => sitesExperience.rebuildSitemap(c.actor, c.params.id))
  .add('GET', S + '/:id/performance', 'SitesSeoController', c => sitesExperience.performance(c.actor, c.params.id))
  .add('GET', S + '/:id/module-readiness', 'SitesModulesController', c => sitesExperience.readiness(c.actor, c.params.id))
  .add('GET', S + '/:id/cookie-policy', 'SitesScriptsController', c => sitesExperience.cookiePolicy(c.actor, c.params.id))
  .add('PUT', S + '/:id/cookie-policy', 'SitesScriptsController', c => sitesExperience.cookiePolicy(c.actor, c.params.id, c.body))
  .add('POST', S + '/:id/scripts', 'SitesScriptsController', c => sitesExperience.createScript(c.actor, c.params.id, c.body), 201)
  .add('GET', S + '/:id/security-preview', 'SitesScriptsController', c => sitesExperience.securityPreview(c.actor, c.params.id))
  .add('POST', S + '/:id/ai/generate', 'SitesAiController', c => sitesExperience.generate(c.actor, c.params.id, c.body), 201)
  .addPublic('GET', S + '/:id/previews/:token', 'SitesPublicController', c => sitesPublisher.preview(c.params.id, c.params.token, c.request.headers.get('x-preview-password'), ip(c.request.headers)));

export const sitesPublicRouter = new PackRouter()
  .addPublic('GET', '/api/v1/public/sites/render', 'SitesPublicController', c => sitesPublisher.renderPublic(c.query, c.request.headers.get('host'), ip(c.request.headers)))
  .addPublic('GET', '/api/v1/public/sites/:slug/commerce-blocks/:bindingId', 'SitesPublicController', c => sitesExperience.commerceBlock(c.params.slug, c.params.bindingId))
  .addPublic('POST', '/api/v1/public/sites/:siteId/consent', 'SitesPublicController', c => sitesExperience.consent(c.params.siteId, c.body, ip(c.request.headers)), 201)
  .addPublic('POST', '/api/v1/public/sites/:siteId/experiment-events', 'SitesPublicController', c => sitesExperience.experimentEvent(c.params.siteId, c.body, ip(c.request.headers) + ':' + (c.request.headers.get('user-agent') ?? '')))
  .addPublic('POST', '/api/v1/public/sites/performance', 'SitesPublicController', c => sitesExperience.recordPerformance(c.body, ip(c.request.headers)), 202)
  .addPublic('GET', '/api/v1/public/sites/exports/:jobId', 'SitesPublicController', c => sitesSites.downloadExport(c.params.jobId, c.query.token ?? ''))
  .addPublic('GET', '/api/v1/public/robots.txt', 'SitesPublicController', c => sitesPublisher.publicRobots(c.request.headers.get('host'), c.query))
  .addPublic('GET', '/api/v1/public/sitemap.xml', 'SitesPublicController', c => sitesPublisher.publicSitemap(c.request.headers.get('host'), c.query));

export class SitesModule {}
Module({ controllers: [...nestControllers(sitesRouter), ...nestControllers(sitesPublicRouter)] })(SitesModule);
