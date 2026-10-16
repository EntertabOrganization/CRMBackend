import { prisma } from '../prisma-client';
import '../platform/register';
import { SuiteRouter } from '../platform/http';
import { AiConfigService } from './config-service';
import { AiConversationService } from './conversation-service';
import { AiDomainService } from './domain-service';
import { AiExternalService } from './external-service';
import { AiGovernanceService } from './governance-service';
import { AiRunService } from './run-service';

const config = new AiConfigService(prisma), runs = new AiRunService(prisma), conversations = new AiConversationService(prisma, runs);
const external = new AiExternalService(prisma), governance = new AiGovernanceService(prisma), domain = new AiDomainService(prisma, runs);
const AI = '/api/v1/ai', R = AI + '/runs/:id';
const auth = (c: { request: { headers: Headers } }) => c.request.headers.get('authorization');
const ip = (c: { request: { headers: Headers } }) => c.request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;

/** 29-AI-CoPilot Workspace HTTP surface. */
export const aiRouter = new SuiteRouter()
  // 01 providers, models, routes
  .workspace('GET', AI + '/providers', () => config.providers())
  .workspace('GET', AI + '/models', c => config.models(c.query))
  .workspace('POST', AI + '/provider-connections', c => config.createConnection(c.actor, c.body, c.requestId), 201)
  .workspace('GET', AI + '/provider-connections', c => config.connections(c.actor))
  .workspace('POST', AI + '/provider-connections/:id/verify', c => config.verifyConnection(c.actor, c.params.id, c.requestId))
  .workspace('POST', AI + '/provider-connections/:id/suspend', c => config.suspendConnection(c.actor, c.params.id, c.requestId))
  .workspace('POST', AI + '/provider-connections/:id/rotate-key', c => config.rotateKey(c.actor, c.params.id, c.body, c.requestId))
  .workspace('GET', AI + '/routes', c => config.routes(c.actor))
  .workspace('POST', AI + '/routes', c => config.createRoute(c.actor, c.body, c.requestId), 201)
  .workspace('PATCH', AI + '/routes/:id', c => config.updateRoute(c.actor, c.params.id, c.body, c.requestId))
  // 02 scenarios, prompts, assistants, retrieval profiles
  .workspace('GET', AI + '/workspace-settings', c => config.settings(c.actor))
  .workspace('PATCH', AI + '/workspace-settings', c => config.updateSettings(c.actor, c.body, c.requestId))
  .workspace('POST', AI + '/prompts', c => config.createPrompt(c.actor, c.body, c.requestId), 201)
  .workspace('GET', AI + '/prompts', c => config.prompts(c.actor, c.query))
  .workspace('POST', AI + '/prompts/:id/publish', c => config.publishPrompt(c.actor, c.params.id, c.body, c.requestId))
  .workspace('POST', AI + '/assistants', c => config.createAssistant(c.actor, c.body, c.requestId), 201)
  .workspace('GET', AI + '/assistants', c => config.assistants(c.actor))
  .workspace('POST', AI + '/assistants/:id/disable', c => config.disableAssistant(c.actor, c.params.id, c.requestId))
  .workspace('POST', AI + '/retrieval-profiles', c => config.createRetrievalProfile(c.actor, c.body, c.requestId), 201)
  .workspace('POST', AI + '/scenarios/:code/runs', c => runs.create(c.actor, { ...(c.body as Record<string, unknown>), scenarioId: c.params.code }), 202)
  // 03 conversations
  .workspace('POST', AI + '/conversations', c => conversations.create(c.actor, c.body, c.requestId), 201)
  .workspace('GET', AI + '/conversations', c => conversations.list(c.actor, c.query))
  .workspace('GET', AI + '/conversations/:id/messages', c => conversations.messages(c.actor, c.params.id, c.query))
  .workspace('POST', AI + '/conversations/:id/messages', c => conversations.send(c.actor, c.params.id, c.body), 202)
  .workspace('POST', AI + '/conversations/:id/archive', c => conversations.archive(c.actor, c.params.id))
  .workspace('DELETE', AI + '/conversations/:id', c => conversations.remove(c.actor, c.params.id, c.requestId), 202)
  .workspace('GET', AI + '/conversations/:id/deletion', c => conversations.deletionStatus(c.actor, c.params.id))
  .workspace('POST', AI + '/conversations/:id/export', c => conversations.export(c.actor, c.params.id, c.requestId), 201)
  .workspace('GET', AI + '/conversation-exports/:artifactId', c => conversations.downloadExport(c.actor, c.params.artifactId))
  // 04 + 06 runs, citations, cancellation, retry
  .workspace('POST', AI + '/runs', c => runs.create(c.actor, c.body), 202)
  .workspace('GET', AI + '/runs', c => runs.list(c.actor, c.query))
  .workspace('GET', R, c => runs.get(c.actor, c.params.id))
  .workspace('POST', R + '/cancel', c => runs.cancel(c.actor, c.params.id))
  .workspace('POST', R + '/retry', c => runs.retry(c.actor, c.params.id), 202)
  .workspace('GET', R + '/citations', c => runs.citations(c.actor, c.params.id))
  // 05 tools & approvals
  .workspace('GET', AI + '/tools', c => config.tools(c.actor, c.query))
  .workspace('PUT', AI + '/tool-policies', c => config.setToolPolicy(c.actor, c.body, c.requestId))
  .workspace('POST', R + '/tool-calls/:callId/approve', c => runs.approveTool(c.actor, c.params.id, c.params.callId, c.body))
  .workspace('POST', R + '/tool-calls/:callId/deny', c => runs.denyTool(c.actor, c.params.id, c.params.callId, c.body))
  .workspace('GET', AI + '/tool-grants', c => config.myGrants(c.actor))
  .workspace('DELETE', AI + '/tool-grants/:grantId', c => config.revokeGrant(c.actor, c.params.grantId, c.requestId))
  // 07 usage & budgets
  .workspace('GET', AI + '/usage', c => runs.usage(c.actor, c.query))
  .workspace('GET', AI + '/usage/:runId', c => runs.runUsage(c.actor, c.params.runId))
  .workspace('GET', AI + '/workspace-budgets', c => config.budget(c.actor))
  .workspace('PATCH', AI + '/workspace-budgets', c => config.setBudget(c.actor, c.body, c.requestId))
  // 08 external MCP clients & grants
  .workspace('POST', AI + '/external-clients', c => external.createClient(c.actor, c.body, c.requestId), 201)
  .workspace('GET', AI + '/external-clients', c => external.clients(c.actor))
  .workspace('POST', AI + '/external-clients/:id/revoke', c => external.revokeClient(c.actor, c.params.id, c.requestId))
  .workspace('POST', AI + '/external-clients/:id/authorize', c => external.authorize(c.actor, c.params.id, c.body, c.requestId))
  .workspace('GET', AI + '/external-grants', c => external.myGrants(c.actor))
  .workspace('DELETE', AI + '/external-grants/:id', c => external.revokeGrant(c.actor, c.params.id, c.requestId))
  .public('POST', AI + '/oauth/token', c => external.token(c.body, ip(c)))
  // 09 governance
  .workspace('POST', R + '/feedback', c => governance.feedback(c.actor, c.params.id, c.body), 201)
  .workspace('GET', AI + '/evaluations', c => governance.evaluations(c.actor, c.query))
  .workspace('POST', AI + '/evaluations/run', c => governance.runEvaluation(c.actor, c.body, c.requestId), 202)
  .workspace('GET', AI + '/security-findings', c => governance.findings(c.actor, c.query))
  .workspace('POST', AI + '/security-findings/:id/resolve', c => governance.resolveFinding(c.actor, c.params.id, c.body, c.requestId))
  .workspace('GET', AI + '/policies', c => governance.policies(c.actor))
  .workspace('PUT', AI + '/policies', c => governance.setPolicy(c.actor, c.body, c.requestId))
  // 10 domain assistance & media
  .workspace('POST', AI + '/scenarios/transcribe', c => domain.transcribe(c.actor, c.body), 202)
  .workspace('GET', R + '/transcript', c => domain.transcript(c.actor, c.params.id))
  .workspace('POST', AI + '/scenarios/extract-fields', c => domain.extractFields(c.actor, c.body), 202)
  .workspace('GET', AI + '/extractions/:id', c => domain.extraction(c.actor, c.params.id))
  .workspace('POST', AI + '/extractions/:id/apply', c => domain.applyExtraction(c.actor, c.params.id, c.body, c.requestId))
  .workspace('POST', AI + '/scenarios/generate-content', c => domain.generateContent(c.actor, c.body), 202)
  .workspace('POST', AI + '/scenarios/generate-image', c => domain.generateImage(c.actor, c.body), 202)
  .workspace('GET', R + '/artifacts', c => domain.artifacts(c.actor, c.params.id))
  .workspace('POST', AI + '/artifacts/:id/review', c => domain.reviewArtifact(c.actor, c.params.id, c.body));

/** Platform model catalog and platform (vault-referenced) provider connections. */
export const platformAiRouter = new SuiteRouter()
  .platform('GET', '/api/v1/platform/ai/models', c => config.models(c.query))
  .platform('POST', '/api/v1/platform/ai/models', c => config.upsertModel(c.actor, c.body, c.requestId), 201)
  .platform('POST', '/api/v1/platform/ai/provider-connections', c => config.createConnection(c.actor, c.body, c.requestId), 201)
  .platform('POST', '/api/v1/platform/ai/provider-connections/:id/verify', c => config.verifyConnection(c.actor, c.params.id, c.requestId))
  .platform('POST', '/api/v1/platform/ai/provider-connections/:id/suspend', c => config.suspendConnection(c.actor, c.params.id, c.requestId));

/** Service-identity (INTERNAL_JOB_TOKEN) endpoints used by other modules. */
const I = '/api/v1/internal/ai';
export const aiInternalRouter = new SuiteRouter()
  .public('POST', I + '/route', c => runs.internalRoute(auth(c), c.body))
  .public('POST', I + '/context/build', c => runs.internalContext(auth(c), c.body))
  .public('POST', I + '/retrieval/evaluate', c => runs.internalEvaluate(auth(c), c.body))
  .public('POST', I + '/tools/:toolId/execute', c => runs.internalToolExecute(auth(c), c.params.toolId, c.body))
  .public('POST', I + '/usage/settle', c => runs.internalSettle(auth(c), c.body));

/** External MCP clients authenticate with a scoped OAuth bearer token, re-resolved on every call. */
export const mcpRouter = new SuiteRouter()
  .public('GET', '/api/v1/mcp/tools', c => external.listTools(auth(c)))
  .public('POST', '/api/v1/mcp/execute-tool', c => external.executeTool(auth(c), c.body));
