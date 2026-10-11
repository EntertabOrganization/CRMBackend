import { NextRequest } from 'next/server';
import { readJson } from '@/src/server/request';

describe('Bounded request JSON', () => {
  it('counts streamed bytes without trusting content-length and cancels oversized input', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Buffer.from('{"x":"')); controller.enqueue(Buffer.alloc(40, 97)); },
      cancel() { cancelled = true; },
    });
    const request = new NextRequest('http://localhost', { method: 'POST', body: stream, duplex: 'half', headers: { 'content-length': '1' } } as ConstructorParameters<typeof NextRequest>[1]);
    await expect(readJson(request, 20)).rejects.toMatchObject({ code: 'REQUEST_BODY_TOO_LARGE', status: 413 });
    expect(cancelled).toBe(true);
  });
  it('accepts exact byte limits and rejects declared oversize before reading', async () => {
    const body = '{"x":"é"}';
    expect(await readJson(new NextRequest('http://localhost', { method: 'POST', body }), Buffer.byteLength(body))).toEqual({ x: 'é' });
    await expect(readJson(new NextRequest('http://localhost', { method: 'POST', body, headers: { 'content-length': '999' } }), 20)).rejects.toMatchObject({ status: 413 });
  });
});
