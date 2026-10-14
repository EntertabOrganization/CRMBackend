import { CRM_EXTENSION_TAGS, crmExtensionPaths } from './openapi-extensions';
import { COMMERCIAL_TAGS, commercialPaths } from './openapi-commercial';
import { INTELLIGENCE_TAGS, intelligencePaths } from './openapi-intelligence';
import { processCommercePaths } from './openapi-process-commerce';
import { workflowDiscussionPaths } from './openapi-workflow-discussion';
import { spaPaths } from './spa/openapi';

const baseDocument = {
  openapi: '3.1.0',
  info: {
    title: 'EntertabCRM Backend API',
    version: '0.1.0',
    description: 'EntertabCRM Auth Module, workspace management, CRM core, custom & required fields, activities and timeline API.',
  },
  servers: [{ url: '/api/v1' }],
  tags: [
    { name: 'Health' },
    { name: 'Auth' },
    { name: 'Workspaces' },
    { name: 'Users' },
    { name: 'Roles' },
    { name: 'Permissions' },
    { name: 'Departments' },
    { name: 'Department Members' },
    { name: 'Partners' },
    { name: 'Audit Logs' },
    { name: 'CRM Pipelines' },
    { name: 'CRM Contacts' },
    { name: 'CRM Companies' },
    { name: 'CRM Leads' },
    { name: 'CRM Deals' },
    { name: 'CRM Sources' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
      },
    },
    schemas: {
      ApiError: {
        type: 'object',
        properties: {
          success: { type: 'boolean', const: false },
          error: {
            type: 'object',
            properties: {
              code: { type: 'string' },
              message: { type: 'string' },
              details: {},
            },
          },
          requestId: { type: 'string' },
        },
      },
      SignupInput: {
        type: 'object',
        required: ['firstName', 'lastName', 'email', 'password'],
        properties: {
          firstName: { type: 'string' },
          lastName: { type: 'string' },
          email: { type: 'string', format: 'email' },
          password: { type: 'string', format: 'password' },
        },
      },
      SigninInput: {
        type: 'object',
        required: ['email', 'password'],
        example: {
          email: 'Admin@entertab.com',
          password: 'Admin@1234',
        },
        properties: {
          email: { type: 'string', format: 'email' },
          password: { type: 'string', format: 'password' },
        },
      },
      TokenInput: {
        type: 'object',
        required: ['token'],
        properties: { token: { type: 'string' } },
      },
      RefreshTokenInput: {
        type: 'object',
        required: ['refreshToken'],
        properties: { refreshToken: { type: 'string' } },
      },
      EmailInput: {
        type: 'object',
        required: ['email'],
        properties: { email: { type: 'string', format: 'email' } },
      },
      ResetPasswordInput: {
        type: 'object',
        required: ['token', 'password'],
        properties: {
          token: { type: 'string' },
          password: { type: 'string', format: 'password' },
        },
      },
      GoogleCredentialInput: {
        type: 'object',
        required: ['credential'],
        properties: { credential: { type: 'string' } },
      },
    },
  },
  paths: {
    '/health/ready': {
      get: {
        tags: ['Health'],
        summary: 'Check database and migration readiness.',
        security: [],
        responses: {
          '200': { description: 'The backend is ready to serve requests.' },
          '503': { description: 'The database is unavailable or migrations are incomplete.' },
        },
      },
    },
    '/auth/signup': authPost('Sign up with email and password.', 'SignupInput'),
    '/auth/verify-email': authPost('Verify email and create the first workspace.', 'TokenInput'),
    '/auth/resend-verification': authPost('Request a new verification email.', 'EmailInput'),
    '/auth/signin': authPost('Sign in with email and password.', 'SigninInput'),
    '/auth/refresh': authPost('Rotate a refresh token.', 'RefreshTokenInput'),
    '/auth/logout': authPost('Revoke one refresh token.', 'RefreshTokenInput'),
    '/auth/logout-all': securedPost('Auth', 'Revoke all refresh tokens for the current user.'),
    '/auth/forgot-password': authPost('Request a password reset email.', 'EmailInput'),
    '/auth/reset-password': authPost('Reset password with a one-time token.', 'ResetPasswordInput'),
    '/auth/google/signup': authPost('Authenticate through a verified Google credential.', 'GoogleCredentialInput'),
    '/auth/google/signin': authPost('Authenticate through a verified Google credential.', 'GoogleCredentialInput'),
    '/auth/me': {
      get: {
        tags: ['Auth'],
        summary: 'Get current user session.',
        security: [{ bearerAuth: [] }],
        responses: standardResponses(),
      },
    },
    '/workspaces': collection('Workspaces'),
    '/workspaces/{id}': resource('Workspaces'),
    '/workspaces/{id}/switch': securedAction('Workspaces', 'Switch active workspace.'),
    '/workspaces/{id}/restore': securedAction('Workspaces', 'Restore a soft-deleted workspace.'),
    '/workspaces/{id}/hard': securedAction('Workspaces', 'Hard delete a soft-deleted workspace.'),
    '/users': collection('Users'),
    '/users/{id}': resource('Users'),
    '/roles': collection('Roles'),
    '/roles/{id}': resource('Roles'),
    '/roles/{id}/permissions': securedAction('Roles', 'Replace permissions assigned to a role.'),
    '/permissions': readonlyCollection('Permissions'),
    '/departments': collection('Departments'),
    '/departments/tree': readonlyCollection('Departments'),
    '/departments/{id}': resource('Departments'),
    '/departments/{id}/children': readonlyCollection('Departments'),
    '/departments/{id}/descendants': readonlyCollection('Departments'),
    '/departments/{id}/ancestors': readonlyCollection('Departments'),
    '/departments/{id}/move': securedAction('Departments', 'Move a department.'),
    '/departments/{id}/sub-departments': securedAction('Departments', 'Create a child department.'),
    '/department-members': collection('Department Members'),
    '/partners/applications': collection('Partners'),
    '/partners/applications/{id}/approve': securedAction('Partners', 'Approve a partner application.'),
    '/audit-logs': readonlyCollection('Audit Logs'),
    '/audit-logs/{id}': readonlyResource('Audit Logs'),
    '/crm/pipelines': collection('CRM Pipelines'),
    '/crm/pipelines/backfill': securedPost('CRM Pipelines', 'Backfill legacy workspace CRM pipeline configuration and current records.'),
    '/crm/pipelines/{id}/deactivate': securedAction('CRM Pipelines', 'Deactivate a pipeline with explicit current-record migration.'),
    '/crm/stages/{id}/deactivate': securedAction('CRM Pipelines', 'Deactivate a stage with explicit current-record migration.'),
    '/crm/stages/{id}/permissions/{roleId}': {
      put: {
        tags: ['CRM Pipelines'],
        summary: 'Set role stage view, enter and leave policy.',
        security: [{ bearerAuth: [] }],
        parameters: [pathId(), { name: 'roleId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: standardResponses(),
      },
    },
    '/crm/contacts': collection('CRM Contacts'),
    '/crm/contacts/{id}/assign': securedAction('CRM Contacts', 'Assign contact responsibility.'),
    '/crm/contacts/{id}/communications': securedAction('CRM Contacts', 'Add a contact communication.'),
    '/crm/contacts/{id}/companies': securedAction('CRM Contacts', 'Link a contact to a company.'),
    '/crm/contact-companies/{id}': {
      delete: {
        tags: ['CRM Contacts'],
        summary: 'Remove a contact-company relationship.',
        security: [{ bearerAuth: [] }],
        parameters: [pathId()],
        responses: standardResponses(),
      },
    },
    '/crm/companies': collection('CRM Companies'),
    '/crm/companies/{id}': {
      delete: {
        tags: ['CRM Companies'],
        summary: 'Soft delete a CRM company.',
        security: [{ bearerAuth: [] }],
        parameters: [pathId()],
        responses: standardResponses(),
      },
    },
    '/crm/companies/{id}/assign': securedAction('CRM Companies', 'Assign company responsibility.'),
    '/crm/companies/{id}/communications': securedAction('CRM Companies', 'Add a company communication.'),
    '/crm/sources': collection('CRM Sources'),
    '/crm/sources/{id}/deactivate': securedAction('CRM Sources', 'Deactivate a CRM source while keeping historical references.'),
    '/crm/leads': collection('CRM Leads'),
    '/crm/leads/{id}/assign': securedAction('CRM Leads', 'Assign lead responsibility.'),
    '/crm/leads/{id}/archive': securedAction('CRM Leads', 'Archive a lead.'),
    '/crm/leads/{id}/restore-archive': securedAction('CRM Leads', 'Restore an archived lead.'),
    '/crm/leads/{id}/delete': securedAction('CRM Leads', 'Soft delete a lead.'),
    '/crm/leads/{id}/restore': securedAction('CRM Leads', 'Restore a soft-deleted lead.'),
    '/crm/leads/{id}/transition': securedAction('CRM Leads', 'Transition a lead between stages or pipelines.'),
    '/crm/leads/{id}/convert': securedAction('CRM Leads', 'Convert a lead into customer records and optionally a deal.'),
    '/crm/deals': collection('CRM Deals'),
    '/crm/deals/{id}/assign': securedAction('CRM Deals', 'Assign deal responsibility.'),
    '/crm/deals/{id}/observers': securedAction('CRM Deals', 'Add a deal observer.'),
    '/crm/deals/{id}/observers/{userId}': {
      delete: {
        tags: ['CRM Deals'],
        summary: 'Remove a deal observer.',
        security: [{ bearerAuth: [] }],
        parameters: [pathId(), { name: 'userId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: standardResponses(),
      },
    },
    '/crm/deals/{id}/transition': securedAction('CRM Deals', 'Transition a deal between stages or pipelines.'),
  },
} as const;

function mergePaths<T extends object>(base: T, extra: Record<string, Record<string, unknown>>): T & Record<string, Record<string, unknown>> {
  const merged: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [path, operations] of Object.entries(extra)) merged[path] = { ...((merged[path] as object | undefined) ?? {}), ...operations };
  return merged as T & Record<string, Record<string, unknown>>;
}

export const openApiDocument = {
  ...baseDocument,
  tags: [...baseDocument.tags, ...CRM_EXTENSION_TAGS, ...COMMERCIAL_TAGS, ...INTELLIGENCE_TAGS, { name: 'Commerce Checkout and Orders' },{ name: 'Workflow Discussions' }],
  paths: mergePaths(mergePaths(mergePaths(mergePaths(mergePaths(mergePaths(baseDocument.paths, crmExtensionPaths()), commercialPaths()), intelligencePaths()), processCommercePaths()),workflowDiscussionPaths()), spaPaths()),
};

function authPost(summary: string, schema: string) {
  return {
    post: {
      tags: ['Auth'],
      summary,
      requestBody: jsonBody(schema),
      responses: standardResponses(),
    },
  };
}

function securedPost(tag: string, summary: string) {
  return {
    post: {
      tags: [tag],
      summary,
      security: [{ bearerAuth: [] }],
      responses: standardResponses(),
    },
  };
}

function securedAction(tag: string, summary: string) {
  return {
    post: {
      tags: [tag],
      summary,
      security: [{ bearerAuth: [] }],
      parameters: [pathId()],
      responses: standardResponses(),
    },
  };
}

function collection(tag: string) {
  return {
    get: {
      tags: [tag],
      summary: `List ${tag.toLowerCase()}.`,
      security: [{ bearerAuth: [] }],
      parameters: queryParameters(),
      responses: standardResponses(true),
    },
    post: {
      tags: [tag],
      summary: `Create ${tag.toLowerCase()}.`,
      security: [{ bearerAuth: [] }],
      responses: standardResponses(),
    },
  };
}

function readonlyCollection(tag: string) {
  return {
    get: {
      tags: [tag],
      summary: `List ${tag.toLowerCase()}.`,
      security: [{ bearerAuth: [] }],
      parameters: queryParameters(),
      responses: standardResponses(true),
    },
  };
}

function resource(tag: string) {
  return {
    get: {
      tags: [tag],
      summary: `Get ${tag.toLowerCase()} by ID.`,
      security: [{ bearerAuth: [] }],
      parameters: [pathId()],
      responses: standardResponses(),
    },
    put: {
      tags: [tag],
      summary: `Replace ${tag.toLowerCase()}.`,
      security: [{ bearerAuth: [] }],
      parameters: [pathId()],
      responses: standardResponses(),
    },
    patch: {
      tags: [tag],
      summary: `Update ${tag.toLowerCase()}.`,
      security: [{ bearerAuth: [] }],
      parameters: [pathId()],
      responses: standardResponses(),
    },
    delete: {
      tags: [tag],
      summary: `Delete ${tag.toLowerCase()}.`,
      security: [{ bearerAuth: [] }],
      parameters: [pathId()],
      responses: standardResponses(),
    },
  };
}

function readonlyResource(tag: string) {
  return {
    get: {
      tags: [tag],
      summary: `Get ${tag.toLowerCase()} by ID.`,
      security: [{ bearerAuth: [] }],
      parameters: [pathId()],
      responses: standardResponses(),
    },
  };
}

function jsonBody(schema: string) {
  return {
    required: true,
    content: {
      'application/json': {
        schema: { $ref: `#/components/schemas/${schema}` },
      },
    },
  };
}

function standardResponses(withMeta = false) {
  return {
    '200': {
      description: 'Successful response.',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              success: { type: 'boolean', const: true },
              data: withMeta ? { type: 'array', items: {} } : {},
              meta: withMeta ? { type: 'object' } : { nullable: true },
            },
          },
        },
      },
    },
    '400': errorResponse(),
    '401': errorResponse(),
    '403': errorResponse(),
    '404': errorResponse(),
    '409': errorResponse(),
    '429': errorResponse(),
  };
}

function errorResponse() {
  return {
    description: 'Error response.',
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/ApiError' },
      },
    },
  };
}

function pathId() {
  return {
    name: 'id',
    in: 'path',
    required: true,
    schema: { type: 'string' },
  };
}

function queryParameters() {
  return [
    { name: 'search', in: 'query', schema: { type: 'string' } },
    { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
    { name: 'limit', in: 'query', schema: { type: 'integer', default: 20, maximum: 100 } },
    { name: 'sortBy', in: 'query', schema: { type: 'string' } },
    { name: 'sortOrder', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'], default: 'asc' } },
    { name: 'filters', in: 'query', schema: { type: 'string' } },
  ];
}
