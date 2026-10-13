const id = { type: 'string',format: 'uuid' };
const schema = (properties: Record<string,unknown>,required: string[]) => ({ type: 'object',additionalProperties: false,properties,required });
const comment = { body: { type: 'string',maxLength: 10000 },fileIds: { type: 'array',maxItems: 20,items: id },mentions: { type: 'array',maxItems: 50,items: id },linkedActivityId: id };
export function workflowDiscussionPaths() {
  const operations = [
    { path: '/workflow-executions/{executionId}/discussion',method: 'get',summary: 'Resolve the authorized shared Timeline discussion; no GET mutation' },
    { path: '/crm/WORKFLOW_EXECUTION/{executionId}/timeline',method: 'get',summary: 'Read shared Workflow execution comments with cursor pagination' },
    { path: '/crm/WORKFLOW_EXECUTION/{executionId}/timeline/comments',method: 'post',summary: 'Create a shared Timeline comment on an authorized execution',body: schema(comment,['body']),key: true,status: 201 },
    { path: '/crm/timeline/comments/{commentId}',method: 'get',summary: 'Read a shared Timeline comment under current source permission' },
    { path: '/crm/timeline/comments/{commentId}',method: 'patch',summary: 'Edit a shared comment under author/moderator scope',body: schema({ body: comment.body,fileIds: comment.fileIds,mentions: comment.mentions,expectedVersion: { type: 'integer',minimum: 1 } },['expectedVersion']) },
    { path: '/crm/timeline/comments/{commentId}',method: 'delete',summary: 'Soft-delete a shared comment; Workflow legal hold prevents deletion' },
  ];
  const paths: Record<string,Record<string,unknown>> = {};
  for (const operation of operations) {
    const parameters = [...operation.path.matchAll(/\{(\w+)\}/g)].map(match => ({ name: match[1],in: 'path',required: true,schema: id }));
    parameters.push({ name: 'x-workspace-id',in: 'header',required: true,schema: id });
    const extra = 'key' in operation ? [{ name: 'Idempotency-Key',in: 'header',required: true,schema: { type: 'string',minLength: 8,maxLength: 128 } }] : [];
    (paths[operation.path] ??= {})[operation.method] = { tags: ['Workflow Discussions'],summary: operation.summary,security: [{ bearerAuth: [] }],parameters: [...parameters,...extra],
      ...('body' in operation ? { requestBody: { required: true,content: { 'application/json': { schema: operation.body } } } } : {}),
      responses: { ['status' in operation ? operation.status! : 200]: { description: 'Shared Timeline result in the standard envelope. Workflow execution values are not discussion content.' },403: { description: 'Current Workflow/source/Timeline permission or scope denied.' },409: { description: 'Version, idempotency or retention conflict.' } } };
  }
  return paths;
}
