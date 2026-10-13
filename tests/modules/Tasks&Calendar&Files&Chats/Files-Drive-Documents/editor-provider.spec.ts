import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { EnvironmentEditingProvider, type EditorSource } from '@/src/server/collab/files/editor-provider';
import { expectAppError } from '@/tests/support/domain';
const previous = { url: process.env.FILE_EDITOR_URL, token: process.env.FILE_EDITOR_TOKEN };
let server: Server;
let mismatch = false, wrongChecksum = false, unavailable = false;
let requests: Array<{ authorization?: string; body: Record<string, unknown> }> = [];
beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    requests.push({ authorization: req.headers.authorization, body });
    if (unavailable) { res.writeHead(503); res.end('provider secret must never be reflected'); return; }
    const bytes = Buffer.from('saved text'), payload = { ...body, userId: mismatch ? randomUUID() : body.userId,
      providerSessionId: body.id, editorUrl: 'https://editor.example/session', mimeType: 'text/plain', dataBase64: bytes.toString('base64'),
      checksum: wrongChecksum ? 'a'.repeat(64) : createHash('sha256').update(bytes).digest('hex') };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  process.env.FILE_EDITOR_URL = `http://127.0.0.1:${address.port}/editor`; process.env.FILE_EDITOR_TOKEN = 'broker-test-secret';
});
afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (previous.url === undefined) delete process.env.FILE_EDITOR_URL; else process.env.FILE_EDITOR_URL = previous.url;
  if (previous.token === undefined) delete process.env.FILE_EDITOR_TOKEN; else process.env.FILE_EDITOR_TOKEN = previous.token;
});
beforeEach(() => { mismatch = false; wrongChecksum = false; unavailable = false; requests = []; });
function source(provider: EditorSource['provider'] = 'INTERNAL_DOCS'): EditorSource {
  const bytes = Buffer.from('original text');
  return { id: randomUUID(), workspaceId: randomUUID(), fileId: randomUUID(), userId: randomUUID(), baseVersionId: randomUUID(), provider,
    name: 'document.txt', mimeType: 'text/plain', bytes, checksum: createHash('sha256').update(bytes).digest('hex'), expiresAt: new Date(Date.now()+300000) };
}
it('edits valid UTF-8 text locally and rejects content/type/integrity corruption', async () => {
  const p = new EnvironmentEditingProvider(), s = source();
  expect(await p.open(s)).toEqual({ providerSessionId: s.id, editorUrl: null });
  expect((await p.save(s, s.mimeType, { dataBase64: Buffer.from('edited').toString('base64') })).bytes.toString()).toBe('edited');
  await expectAppError(() => p.open({ ...s, mimeType: 'image/png' }), 'FILE_NOT_EDITABLE', 409);
  await expectAppError(() => p.open({ ...s, checksum: 'a'.repeat(64) }), 'EDIT_PROVIDER_ERROR', 502);
  await expectAppError(() => p.save(s, s.mimeType, { dataBase64: Buffer.from([255]).toString('base64') }), 'EDIT_PROVIDER_ERROR', 502);
  await expectAppError(() => p.save(s, s.mimeType, { dataBase64: 'not-base64' }), 'EDIT_PROVIDER_ERROR', 502);
  expect(requests).toHaveLength(0);
});
it('authenticates broker requests, pins identities and verifies save receipts instead of trusting client bytes', async () => {
  const p = new EnvironmentEditingProvider(), s = source('CUSTOM');
  expect(await p.open(s)).toEqual({ providerSessionId: s.id, editorUrl: 'https://editor.example/session' });
  const saved = await p.save(s, s.mimeType, { saveId: 'save-1' }); expect(saved.bytes.toString()).toBe('saved text');
  expect(requests[0].authorization).toBe('Bearer broker-test-secret'); expect(requests[0].body).toMatchObject({ id: s.id, fileId: s.fileId, baseVersionId: s.baseVersionId });
  await expectAppError(() => p.save(s, s.mimeType, { saveId: 'save-1', dataBase64: 'YQ==' }), 'EDIT_PROVIDER_ERROR', 400);
  await p.close(s); expect(requests).toHaveLength(3);
});
it('fails closed on unbound provider results, corrupt saves and provider failures without reflecting secrets', async () => {
  const p = new EnvironmentEditingProvider(), s = source('ONLYOFFICE');
  mismatch = true; await expectAppError(() => p.open(s), 'EDIT_PROVIDER_ERROR', 502); mismatch = false;
  wrongChecksum = true; await expectAppError(() => p.save(s, s.mimeType, { saveId: 'save-2' }), 'EDIT_PROVIDER_ERROR', 502); wrongChecksum = false;
  unavailable = true; await expect(p.open(s)).rejects.toMatchObject({ code: 'EDIT_PROVIDER_ERROR', status: 502 });
  try { await p.open(s); } catch (error) { expect(String(error)).not.toContain('broker-test-secret'); expect(String(error)).not.toContain('provider secret'); }
});
it('requires configured vendor credentials while leaving the local text provider available', () => {
  const p = new EnvironmentEditingProvider(), token = process.env.FILE_EDITOR_TOKEN; delete process.env.FILE_EDITOR_TOKEN;
  try { expect(() => p.assertConfigured('GOOGLE_DOCS')).toThrow('Configure the editing provider'); expect(() => p.assertConfigured('INTERNAL_DOCS')).not.toThrow(); }
  finally { process.env.FILE_EDITOR_TOKEN = token; }
});
