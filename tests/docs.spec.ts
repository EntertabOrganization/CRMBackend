import { openApiDocument } from '@/src/server/openapi';

describe('API documentation', () => {
  it('publishes Swagger/OpenAPI entries for auth and protected module routes', () => {
    expect(openApiDocument.openapi).toBe('3.1.0');
    expect(openApiDocument.paths['/auth/signup'].post.requestBody).toBeTruthy();
    expect(openApiDocument.paths['/auth/me'].get.security).toEqual([{ bearerAuth: [] }]);
    expect(openApiDocument.components.schemas.SigninInput.example).toEqual({
      email: 'Admin@entertab.com',
      password: 'Admin@1234',
    });
    expect(openApiDocument.paths['/workspaces']).toHaveProperty('get');
    expect(openApiDocument.paths['/audit-logs/{id}']).toHaveProperty('get');
    expect(openApiDocument.paths['/crm/pipelines']).toHaveProperty('post');
    expect(openApiDocument.paths['/crm/pipelines/backfill']).toHaveProperty('post');
    expect(openApiDocument.paths['/crm/pipelines/{id}/deactivate']).toHaveProperty('post');
    expect(openApiDocument.paths['/crm/stages/{id}/deactivate']).toHaveProperty('post');
    expect(openApiDocument.paths['/crm/stages/{id}/permissions/{roleId}']).toHaveProperty('put');
    expect(openApiDocument.paths['/crm/contacts']).toHaveProperty('get');
    expect(openApiDocument.paths['/crm/contacts']).toHaveProperty('post');
    expect(openApiDocument.paths['/crm/contacts/{id}/assign']).toHaveProperty('post');
    expect(openApiDocument.paths['/crm/companies']).toHaveProperty('get');
    expect(openApiDocument.paths['/crm/companies']).toHaveProperty('post');
    expect(openApiDocument.paths['/crm/companies/{id}/assign']).toHaveProperty('post');
    expect(openApiDocument.paths['/crm/sources']).toHaveProperty('post');
    expect(openApiDocument.paths['/crm/sources/{id}/deactivate']).toHaveProperty('post');
    expect(openApiDocument.paths['/crm/leads']).toHaveProperty('get');
    expect(openApiDocument.paths['/crm/leads/{id}/assign']).toHaveProperty('post');
    expect(openApiDocument.paths['/crm/leads/{id}/archive']).toHaveProperty('post');
    expect(openApiDocument.paths['/crm/leads/{id}/restore']).toHaveProperty('post');
    expect(openApiDocument.paths['/crm/leads/{id}/transition']).toHaveProperty('post');
    expect(openApiDocument.paths['/crm/leads/{id}/convert']).toHaveProperty('post');
    expect(openApiDocument.paths['/crm/deals']).toHaveProperty('get');
    expect(openApiDocument.paths['/crm/deals/{id}/assign']).toHaveProperty('post');
    expect(openApiDocument.paths['/crm/deals/{id}/observers']).toHaveProperty('post');
    expect(openApiDocument.paths['/crm/deals/{id}/observers/{userId}']).toHaveProperty('delete');
    expect(openApiDocument.paths['/crm/deals/{id}/transition']).toHaveProperty('post');
  });
});
