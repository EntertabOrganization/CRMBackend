import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { HttpContentProcessor } from '@/src/server/collab/files/content-processor';
let server: Server, base: string;
const bytes = Buffer.from('scanner input'), checksum = createHash('sha256').update(bytes).digest('hex');
const received: string[] = [];
beforeAll(async () => {
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(bytes);
    expect(request.headers.authorization).toBe('Bearer fixture-token');
    expect(request.headers['x-content-sha256']).toBe(checksum);
    expect(request.headers['idempotency-key']).toBe(`file-processing:${checksum}:text/plain`);
    received.push(request.url!);
    response.setHeader('content-type', 'application/json');
    if (request.url === '/timeout') return;
    if (request.url === '/redirect') { response.writeHead(307, { location: `${base}/clean` }); response.end(); return; }
    if (request.url === '/failure') { response.writeHead(503); response.end('private provider diagnostic'); return; }
    if (request.url === '/oversize') { response.end('x'.repeat(5000)); return; }
    response.end(JSON.stringify({ checksum: request.url === '/wrong-checksum' ? '0'.repeat(64) : checksum,
      scanStatus: request.url === '/blocked' ? 'BLOCKED' : 'CLEAN', processed: request.url !== '/pending' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
it('sends exact bytes to the authenticated service and accepts checksum-bound clean, blocked and pending verdicts', async () => {
  expect(await new HttpContentProcessor(`${base}/clean`, 'fixture-token').process(bytes, 'text/plain')).toEqual({ scanStatus: 'CLEAN', processed: true });
  expect(await new HttpContentProcessor(`${base}/blocked`, 'fixture-token').process(bytes, 'text/plain')).toEqual({ scanStatus: 'BLOCKED', processed: true });
  expect(await new HttpContentProcessor(`${base}/pending`, 'fixture-token').process(bytes, 'text/plain')).toEqual({ scanStatus: 'CLEAN', processed: false });
});
it('rejects insecure deployment configuration without making network requests', () => {
  for (const url of ['http://192.0.2.1/process', 'https://user:password@example.com/process', 'https://example.com/process?secret=value', 'file:///tmp/object'])
    expect(() => new HttpContentProcessor(url, 'fixture-token').assertConfigured()).toThrow();
  expect(() => new HttpContentProcessor(`${base}/clean`, '').assertConfigured()).toThrow();
});
it('fails closed on redirects, wrong checksums, excessive responses, provider failure and timeout without exposing diagnostics', async () => {
  const cleanRequests = received.filter(url => url === '/clean').length;
  for (const suffix of ['/redirect', '/wrong-checksum', '/oversize', '/failure', '/timeout']) {
    await expect(new HttpContentProcessor(`${base}${suffix}`, 'fixture-token', suffix === '/timeout' ? 20 : 5000).process(bytes, 'text/plain'))
      .rejects.toMatchObject({ code: 'FILE_PROCESSOR_UNAVAILABLE', status: 503, message: 'The scanner and content processor are unavailable.' });
  }
  expect(received.filter(url => url === '/clean')).toHaveLength(cleanRequests);
});
