import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { NextRequest } from 'next/server';
import { prepareProcessPlatformDatabase } from './support/process-platform-db';
import { resolvePrincipal } from '../src/server/process-platform/context';
import { WorkflowDefinitionService } from '../src/server/workflows/definition-service';
import { WorkflowExecutionService } from '../src/server/workflows/execution-service';
import { ResourceTimelineService } from '../src/server/activities/resource-timeline-service';
import { signAccessToken } from '../src/server/security';
import { resetRateLimits } from '../src/server/rate-limit';

jest.setTimeout(120000);
let db: PrismaClient,discussions: ResourceTimelineService;
beforeAll(async () => {
  const url = await prepareProcessPlatformDatabase('truecrm_workflow_discussion_test'); db = new PrismaClient({ datasources: { db: { url } } }); discussions = new ResourceTimelineService(db);
},300000);
afterAll(async () => { await db?.$disconnect(); const { prisma } = await import('../src/server/prisma-client'); await prisma.$disconnect(); });
beforeEach(() => resetRateLimits());

async function fixture() {
  const user = await db.user.create({ data: { firstName: 'Workflow',lastName: 'Discussion',email: randomUUID()+'@example.test',status: 'ACTIVE' } });
  const workspace = await db.workspace.create({ data: { name: 'Workflow',slug: randomUUID(),ownerUserId: user.id } });
  const role = await db.role.create({ data: { workspaceId: workspace.id,name: 'Operator' } });
  await db.workspaceMembership.create({ data: { workspaceId: workspace.id,userId: user.id,roleId: role.id } });
  await db.rolePermission.createMany({ data: (await db.permission.findMany()).map(p => ({ roleId: role.id,permissionId: p.id,scope: 'WORKSPACE' as const })) });
  const actor = await resolvePrincipal(db,workspace.id,user.id);
  const contact = await db.crmContact.create({ data: { workspaceId: workspace.id,firstName: 'Bound',lastName: 'Contact',displayName: 'Bound Contact',responsibleUserId: user.id } });
  const definitions = new WorkflowDefinitionService(db),definition = await definitions.create(actor,{ name: 'Discussion',code: 'DISCUSSION',type: 'SEQUENTIAL',boundEntityType: 'CONTACT' });
  const version = await definitions.newVersion(actor,definition.id,{}),start = randomUUID(),end = randomUUID();
  await definitions.editGraph(actor,definition.id,version.id,'REPLACE',{ expectedVersion: 1,
    nodes: [{ id: start,nodeKey: 'START',nodeType: 'START',config: {},position: { x: 0,y: 0 } },{ id: end,nodeKey: 'END',nodeType: 'END',config: {},position: { x: 1,y: 0 } }],
    edges: [{ id: randomUUID(),fromNodeId: start,toNodeId: end,edgeType: 'NEXT',sortOrder: 0 }],parameters: [],constants: [],
    variables: [{ code: 'PRIVATE_NOTE',datatype: 'TEXT',required: false,validation: {},defaultValue: 'private-workflow-marker',classification: 'SENSITIVE' }] });
  await definitions.publish(actor,definition.id,version.id,{ expectedVersion: 2 });
  const execution = await new WorkflowExecutionService(db,definitions).start(actor,definition.id,{ entityType: 'CONTACT',entityId: contact.id,parameters: {} },randomUUID());
  return { actor,user,workspace,role,contact,executionId: execution.executionId };
}

describe('Changed Workflow discussion and shared Timeline integration', () => {
  it('starts the changed runtime without circular initialization and enforces discussion authentication', () => {
    const script = "Promise.all([import('./src/server/process-platform/main.ts'),import('@nestjs/common'),import('node:net')]).then(async ([runtime,nest,net]) => { nest.Logger.overrideLogger(false); const probe=net.createServer(); await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve)); const port=probe.address().port; await new Promise(resolve=>probe.close(resolve)); const app=await (runtime.startProcessPlatform ?? runtime.default.startProcessPlatform)(port); try { const response=await fetch('http://127.0.0.1:'+port+'/api/v1/workflow-executions/00000000-0000-4000-8000-000000000000/discussion'); if(response.status!==401)throw new Error('Discussion route did not enforce authentication'); process.stdout.write('READY'); } finally { await app.close(); } }).catch(error => { process.stderr.write(error.stack); process.exitCode=1; });";
    const output = execFileSync(process.execPath,['--import','tsx','-e',script],{ cwd: process.cwd(),stdio: 'pipe',timeout: 60000 }).toString();
    expect(output).toBe('READY');
  });

  it('returns an authorized shared reference with no GET mutation or private execution values', async () => {
    const f = await fixture(),before = await db.outboxEvent.count({ where: { workspaceId: f.workspace.id } });
    const reference = await discussions.reference(f.actor,f.executionId);
    expect(reference.provider).toBe('TIMELINE'); expect(reference.sharedDiscussionId).toBe(f.executionId);
    expect(JSON.stringify(reference)).not.toContain('private-workflow-marker');
    expect((await discussions.read(f.actor,f.executionId,{})).data).toEqual([]);
    expect(await db.outboxEvent.count({ where: { workspaceId: f.workspace.id } })).toBe(before);
    expect(await db.crmTimelineComment.count({ where: { entityId: f.executionId } })).toBe(0);
  });

  it('uses existing shared comments, sanitizes text and deduplicates concurrent writes atomically', async () => {
    const f = await fixture(),key = randomUUID(),input = { body: '<b>Hello</b>',mentions: [f.user.id] };
    const [a,b] = await Promise.all([discussions.create(f.actor,f.executionId,input,key),discussions.create(f.actor,f.executionId,input,key)]);
    expect(a.id).toBe(b.id); expect(a.body).toBe('Hello');
    expect(await db.crmTimelineComment.count({ where: { entityType: 'WORKFLOW_EXECUTION',entityId: f.executionId } })).toBe(1);
    expect(await db.outboxEvent.count({ where: { entityId: f.executionId,eventType: 'TIMELINE_COMMENT_CREATED' } })).toBe(1);
    expect(await db.auditLog.count({ where: { entityId: a.id as string,action: 'TIMELINE.COMMENT_CREATED' } })).toBe(1);
    expect((await discussions.read(f.actor,f.executionId,{})).data[0]).toMatchObject({ body: 'Hello',kind: 'COMMENT' });
    await expect(discussions.create(f.actor,f.executionId,{ body: 'Changed' },key)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('rejects stale edits, respects legal hold, and soft deletes through the shared owner', async () => {
    const f = await fixture(),created = await discussions.create(f.actor,f.executionId,{ body: 'Original' },randomUUID()),id = created.id as string;
    const edited = await discussions.comment(f.actor,id,'EDIT',{ body: 'Changed',expectedVersion: 1 }); expect(edited.body).toBe('Changed');
    await expect(discussions.comment(f.actor,id,'EDIT',{ body: 'Stale',expectedVersion: 1 })).rejects.toMatchObject({ code: 'TIMELINE_COMMENT_VERSION_CONFLICT' });
    await db.workflowExecution.update({ where: { id: f.executionId },data: { legalHold: true } });
    await expect(discussions.comment(f.actor,id,'DELETE')).rejects.toMatchObject({ code: 'WORKFLOW_RETENTION_HOLD' });
    await db.workflowExecution.update({ where: { id: f.executionId },data: { legalHold: false } });
    expect((await discussions.comment(f.actor,id,'DELETE')).body).toBeNull();
    expect((await db.crmTimelineComment.findUniqueOrThrow({ where: { id } })).body).toBe('Changed');
  });

  it('checks current Workflow and Timeline grants, source visibility and tenant references', async () => {
    const f = await fixture(),other = await fixture();
    await expect(discussions.reference(other.actor,f.executionId)).rejects.toMatchObject({ code: 'WORKFLOW_EXECUTION_NOT_FOUND' });
    const permission = await db.permission.findUniqueOrThrow({ where: { key: 'WORKFLOW.EXECUTION_VIEW' } });
    await db.rolePermission.update({ where: { roleId_permissionId: { roleId: f.role.id,permissionId: permission.id } },data: { isDeleted: true } });
    await expect(discussions.reference(f.actor,f.executionId)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(db.crmTimelineComment.create({ data: { workspaceId: other.workspace.id,entityType: 'WORKFLOW_EXECUTION',entityId: f.executionId,authorUserId: other.user.id,body: 'Foreign' } })).rejects.toMatchObject({ code: 'P2003' });
  });

  it('serves the new reference and shared comment handlers through authenticated HTTP requests', async () => {
    const f = await fixture(),token = await signAccessToken(f.user.id);
    // Reload HTTP modules against this explicitly selected fixture client, not a pre-setup singleton.
    jest.resetModules();
    (globalThis as typeof globalThis & { __trueAgentPrisma?: PrismaClient }).__trueAgentPrisma = db;
    const req = (method: string,path: string,body?: unknown) => new NextRequest('http://localhost'+path,{ method,headers: { authorization: 'Bearer '+token,'x-workspace-id': f.workspace.id,'content-type': 'application/json','idempotency-key': randomUUID() },body: body===undefined ? undefined : JSON.stringify(body) });
    const { workflowRouter } = await import('../src/server/workflows/routes');
    expect((await workflowRouter.dispatch(req('GET','/api/v1/workflow-executions/'+f.executionId+'/discussion'))).status).toBe(200);
    const timeline = await import('../app/api/v1/crm/[entityType]/[entityId]/timeline/route');
    const comments = await import('../app/api/v1/crm/[entityType]/[entityId]/timeline/comments/route');
    const params = Promise.resolve({ entityType: 'WORKFLOW_EXECUTION',entityId: f.executionId });
    const path = '/api/v1/crm/WORKFLOW_EXECUTION/'+f.executionId+'/timeline';
    const posted = await comments.POST(req('POST',path+'/comments',{ body: 'HTTP comment' }),{ params }); expect(posted.status).toBe(201);
    const id = (await posted.json()).data.id;
    expect((await timeline.GET(req('GET',path),{ params })).status).toBe(200);
    const item = await import('../app/api/v1/crm/timeline/comments/[commentId]/route');
    const context = { params: Promise.resolve({ commentId: id }) },itemPath = '/api/v1/crm/timeline/comments/'+id;
    expect((await item.GET(req('GET',itemPath),context)).status).toBe(200);
    expect((await item.PATCH(req('PATCH',itemPath,{ body: 'Edited HTTP',expectedVersion: 1 }),context)).status).toBe(200);
    expect((await item.DELETE(req('DELETE',itemPath,{}),context)).status).toBe(200);
  });

  it('enforces explicit owner scopes and does not grant visibility through mentions', async () => {
    const f = await fixture();
    const user = await db.user.create({ data: { firstName: 'Scoped',lastName: 'Owner',email: randomUUID()+'@example.test',status: 'ACTIVE' } });
    const role = await db.role.create({ data: { workspaceId: f.workspace.id,name: 'Scoped owner',isOwnerRole: true } });
    await db.workspaceMembership.create({ data: { workspaceId: f.workspace.id,userId: user.id,roleId: role.id } });
    await db.rolePermission.createMany({ data: (await db.permission.findMany()).map(p => ({ roleId: role.id,permissionId: p.id,scope: ['timeline.read','timeline.comment_edit','timeline.comment_delete'].includes(p.key) ? 'OWN' as const : 'WORKSPACE' as const })) });
    const actor = await resolvePrincipal(db,f.workspace.id,user.id);
    await expect(discussions.reference(actor,f.executionId)).rejects.toMatchObject({ code: 'TIMELINE_ACCESS_FORBIDDEN' });
    const created = await discussions.create(f.actor,f.executionId,{ body: 'Private thread',mentions: [user.id] },randomUUID());
    const mention = await db.outboxEvent.findFirstOrThrow({ where: { entityId: f.executionId,eventType: 'TIMELINE_COMMENT_MENTIONED' } });
    expect(mention.payload).toMatchObject({ mentionedUserId: user.id,canAccessRecord: false });
    await expect(discussions.comment(actor,created.id as string,'EDIT',{ body: 'Denied',expectedVersion: 1 })).rejects.toMatchObject({ code: 'TIMELINE_COMMENT_EDIT_FORBIDDEN' });
    await expect(discussions.comment(actor,created.id as string,'DELETE')).rejects.toMatchObject({ code: 'TIMELINE_COMMENT_DELETE_FORBIDDEN' });
    const permission = await db.permission.findUniqueOrThrow({ where: { key: 'timeline.comment' } });
    await db.rolePermission.update({ where: { roleId_permissionId: { roleId: role.id,permissionId: permission.id } },data: { isDeleted: true } });
    await expect(discussions.create(actor,f.executionId,{ body: 'Denied' },randomUUID())).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const readPermission = await db.permission.findUniqueOrThrow({ where: { key: 'timeline.read' } });
    await db.rolePermission.update({ where: { roleId_permissionId: { roleId: f.role.id,permissionId: readPermission.id } },data: { isDeleted: true } });
    const selfMention = await discussions.create(f.actor,f.executionId,{ body: 'Comment-only author',mentions: [f.user.id] },randomUUID());
    const selfEvent = await db.outboxEvent.findFirstOrThrow({ where: { entityId: f.executionId,eventType: 'TIMELINE_COMMENT_MENTIONED',payload: { path: ['commentId'],equals: selfMention.id as string } } });
    expect(selfEvent.payload).toMatchObject({ mentionedUserId: f.user.id,canAccessRecord: false });
  });
});
