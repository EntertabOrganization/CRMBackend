import { prisma } from '../prisma-client';
import '../platform/register';
import { SuiteRouter } from '../platform/http';
import { PartnerAccessService } from './access-service';
import { PartnerCommercialService } from './commercial-service';
import { PartnerFinanceService } from './finance-service';
import { PartnerGovernanceService } from './governance-service';
import { PartnerProgramService } from './program-service';

const program = new PartnerProgramService(prisma), commercial = new PartnerCommercialService(prisma), access = new PartnerAccessService(prisma);
const finance = new PartnerFinanceService(prisma), governance = new PartnerGovernanceService(prisma);
const ip = (c: { request: { headers: Headers } }) => c.request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
const mfa = (c: { request: { headers: Headers } }) => c.request.headers.get('x-mfa-assertion');
const auth = (c: { request: { headers: Headers } }) => c.request.headers.get('authorization');
const P = '/api/v1/partners/:partnerId', A = '/api/v1/platform';

/** Partner portal: authenticated users acting through their Partner membership (never a Workspace principal). */
export const partnerPortalRouter = new SuiteRouter()
  .public('POST', '/api/v1/public/partners/applications', c => program.submitPublic(c.body, ip(c), c.requestId), 202)
  .user('GET', '/api/v1/partners/applications/me', c => program.myApplications(c.actor))
  .user('GET', '/api/v1/partners/me', c => program.myPartners(c.actor))
  .user('POST', '/api/v1/partners/invitations/accept', c => program.acceptInvitation(c.actor, c.body, c.requestId))
  // 02 members & roles
  .user('POST', P + '/members/invitations', c => program.invite(c.actor, c.params.partnerId, c.body, c.requestId), 202)
  .user('GET', P + '/members', c => program.members(c.actor, c.params.partnerId, c.query))
  .user('PATCH', P + '/members/:memberId', c => program.updateMember(c.actor, c.params.partnerId, c.params.memberId, c.body, c.requestId))
  .user('GET', P + '/roles', c => program.roles(c.actor, c.params.partnerId))
  .user('POST', P + '/roles', c => program.createRole(c.actor, c.params.partnerId, c.body, c.requestId), 201)
  .user('PATCH', P + '/roles/:roleId', c => program.updateRole(c.actor, c.params.partnerId, c.params.roleId, c.body, c.requestId))
  .user('DELETE', P + '/roles/:roleId', c => program.deleteRole(c.actor, c.params.partnerId, c.params.roleId, c.requestId))
  // 03 discounts
  .user('GET', P + '/discounts', c => commercial.discounts(c.actor, c.params.partnerId))
  // 04 customer workspaces
  .user('POST', P + '/customer-workspaces', c => commercial.provision(c.actor, c.params.partnerId, c.body, c.requestId), 201)
  .user('GET', P + '/customer-workspaces', c => commercial.customerWorkspaces(c.actor, c.params.partnerId, c.query))
  .user('POST', P + '/workspaces/:workspaceId/relationship', c => commercial.link(c.actor, c.params.partnerId, c.params.workspaceId, c.body, c.requestId), 201)
  .user('POST', P + '/workspaces/:workspaceId/relationship/end', c => commercial.endRelation(c.actor, c.params.partnerId, c.params.workspaceId, c.body, c.requestId))
  // 05 delegated access
  .user('POST', P + '/access-requests', c => access.request(c.actor, c.params.partnerId, c.body, c.requestId), 201)
  .user('GET', P + '/delegations', c => access.partnerDelegations(c.actor, c.params.partnerId))
  // 06 referrals
  .user('POST', P + '/referral-links', c => commercial.createReferralLink(c.actor, c.params.partnerId, c.body, c.requestId), 201)
  .user('POST', P + '/referral-links/:linkId/revoke', c => commercial.revokeReferralLink(c.actor, c.params.partnerId, c.params.linkId, c.requestId))
  .user('GET', P + '/referrals', c => commercial.referrals(c.actor, c.params.partnerId, c.query))
  // 07/08 commissions & payouts
  .user('GET', P + '/commissions', c => finance.commissions(c.actor, c.params.partnerId, c.query))
  .user('POST', P + '/payout-requests', c => finance.requestPayout(c.actor, c.params.partnerId, c.body, c.requestId), 201)
  .user('GET', P + '/payouts', c => finance.payouts(c.actor, c.params.partnerId, c.query))
  .user('POST', P + '/payouts/:payoutId/cancel', c => finance.cancelPayout(c.actor, c.params.partnerId, c.params.payoutId, c.requestId))
  // 10 dashboard & reports
  .user('GET', P + '/dashboard', c => governance.dashboard(c.actor, c.params.partnerId, c.query))
  .user('PUT', P + '/dashboard/preferences', c => governance.savePreferences(c.actor, c.params.partnerId, c.body))
  .user('POST', P + '/reports/export', c => governance.requestExport(c.actor, c.params.partnerId, c.body, c.requestId), 202)
  .user('GET', P + '/reports/:jobId/download', c => governance.download(c.actor, c.params.partnerId, c.params.jobId));

/** Platform Partner administration (platform.partner.* grants; step-up where money or irreversible). */
export const platformPartnerRouter = new SuiteRouter()
  .platform('GET', A + '/partner-applications', c => program.listApplications(c.actor, c.query))
  .platform('POST', A + '/partner-applications/:id/approve', c => program.approve(c.actor, c.params.id, c.body, mfa(c), c.requestId))
  .platform('POST', A + '/partner-applications/:id/reject', c => program.reject(c.actor, c.params.id, c.body, c.requestId))
  .platform('GET', A + '/partners', c => governance.platformPartners(c.actor, c.query))
  .platform('POST', A + '/partners/:id/discount-rules', c => commercial.createRule(c.actor, c.params.id, c.body, c.requestId), 201)
  .platform('PATCH', A + '/partners/:id/discount-rules/:ruleId', c => commercial.updateRule(c.actor, c.params.id, c.params.ruleId, c.body, c.requestId))
  .platform('POST', A + '/partners/attribution-disputes', c => commercial.disputeAttribution(c.actor, c.body, c.requestId))
  .platform('POST', A + '/partners/:id/suspend', c => governance.suspend(c.actor, c.params.id, c.body, c.requestId))
  .platform('POST', A + '/partners/:id/reactivate', c => governance.reactivate(c.actor, c.params.id, c.body, c.requestId))
  .platform('DELETE', A + '/partners/:id', c => governance.softDelete(c.actor, c.params.id, c.body, c.requestId))
  .platform('POST', A + '/partners/:id/restore', c => governance.restore(c.actor, c.params.id, c.requestId))
  .platform('POST', A + '/partners/:id/purge', c => governance.purge(c.actor, c.params.id, c.body, mfa(c), c.requestId))
  .platform('GET', A + '/partners/:id/lifecycle', c => governance.lifecycleHistory(c.actor, c.params.id))
  .platform('POST', A + '/partner-transfers/:id/approve', c => commercial.approveTransfer(c.actor, c.params.id, c.body, c.requestId))
  .platform('POST', A + '/partner-commission-policies', c => finance.createPolicy(c.actor, c.body, c.requestId), 201)
  .platform('POST', A + '/partner-commissions/:id/status', c => finance.setCommissionStatus(c.actor, c.params.id, c.body, c.requestId))
  .platform('GET', A + '/partner-payouts', c => finance.platformPayouts(c.actor, c.query))
  .platform('POST', A + '/partner-payouts/:id/approve', c => finance.approvePayout(c.actor, c.params.id, c.body, mfa(c), c.requestId))
  .platform('POST', A + '/partner-payouts/:id/record-payment', c => finance.recordPayment(c.actor, c.params.id, c.body, mfa(c), c.requestId))
  .platform('POST', A + '/partner-payouts/:id/fail', c => finance.failPayout(c.actor, c.params.id, c.body, c.requestId))
  .platform('POST', A + '/partner-payouts/:id/reconcile', c => finance.reconcilePayout(c.actor, c.params.id, c.body, c.requestId));

const W = '/api/v1/workspaces/:workspaceId';
/** Customer-side controls: delegated access and transfer consent. */
export const workspacePartnerRouter = new SuiteRouter()
  .workspace('GET', W + '/partner-access', c => access.customerList(c.actor, c.params.workspaceId))
  .workspace('POST', W + '/partner-access/requests', c => access.customerRequest(c.actor, c.params.workspaceId, c.body, c.requestId), 201)
  .workspace('POST', W + '/partner-access/:grantId/approve', c => access.approve(c.actor, c.params.workspaceId, c.params.grantId, c.body, c.requestId))
  .workspace('POST', W + '/partner-access/:grantId/reject', c => access.reject(c.actor, c.params.workspaceId, c.params.grantId, c.body, c.requestId))
  .workspace('POST', W + '/partner-access/:grantId/revoke', c => access.revoke(c.actor, c.params.workspaceId, c.params.grantId, c.body, c.requestId))
  .workspace('POST', W + '/partner-transfer-requests', c => commercial.requestTransfer(c.actor, c.params.workspaceId, c.body, c.requestId), 202);

/** Service-identity endpoints. */
export const partnerInternalRouter = new SuiteRouter()
  .public('POST', '/api/v1/internal/partners/resolve-discount', c => commercial.internalResolve(auth(c), c.body))
  .public('POST', '/api/v1/internal/partners/referral-touches/record', c => commercial.recordTouch(auth(c), c.body))
  .public('POST', '/api/v1/internal/partners/commission-events/settled', c => finance.internalSettled(auth(c), c.body))
  .public('POST', '/api/v1/internal/partners/commission-events/refund', c => finance.internalRefund(auth(c), c.body));
