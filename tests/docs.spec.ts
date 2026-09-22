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
  });
});
