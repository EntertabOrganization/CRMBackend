import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors';
import { resolveSecret } from '../suite/providers';
import { decrypt } from '../suite/kernel';

export type ChatMessage = { role: 'user' | 'assistant'; content: string };
export type InferRequest = { model: string; system: string; messages: ChatMessage[]; maxTokens: number; idempotencyKey: string; json?: boolean; onDelta?: (text: string) => Promise<void> };
export type InferResult = { requestId: string; text: string; usage: { inputTokens: number; outputTokens: number; cachedTokens: number }; finishReason: string };
export type ProviderHealth = { ok: boolean; detail: string };
/** Failure classes drive retry/fallback: TRANSIENT (not accepted, safe to retry), PERMANENT, UNKNOWN (maybe accepted → reconcile first). */
export class ProviderFailure extends Error { constructor(readonly kind: 'TRANSIENT' | 'PERMANENT' | 'UNKNOWN', readonly code: string, message: string) { super(message); } }
export interface AiModelAdapter {
  code: string;
  validateConnection(secret: string, endpoint: string | null): Promise<ProviderHealth>;
  infer(secret: string, endpoint: string | null, req: InferRequest): Promise<InferResult>;
  /** Most providers expose no request lookup; UNKNOWN means "do not resend automatically". */
  reconcile(requestId: string): Promise<'ACCEPTED' | 'COMPLETED' | 'NOT_FOUND' | 'UNKNOWN'>;
  embed?(secret: string, endpoint: string | null, model: string, input: string): Promise<{ requestId: string; vector: number[]; inputTokens: number }>;
  transcribe?(secret: string, endpoint: string | null, audio: Buffer, mimeType: string, language: string | null, options?: { model: string; diarization: boolean }): Promise<{ requestId: string; text: string; durationSeconds: number; segments?: Array<{ speaker: string; start: number; end: number; text: string }> }>;
  generateImage?(secret: string, endpoint: string | null, prompt: string, idempotencyKey: string): Promise<{ requestId: string; bytes: Buffer; mimeType: string }>;
}

const TIMEOUT_MS = () => Number(process.env.AI_PROVIDER_TIMEOUT_MS ?? 60000);
async function call(url: string, init: RequestInit): Promise<Record<string, any>> {
  let res: Response;
  try { res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS()) }); }
  catch (error) {
    // Connection refused before sending is transient; a timeout/abort after sending may have been accepted.
    const name = (error as { name?: string; cause?: { code?: string } }).name, code = (error as { cause?: { code?: string } }).cause?.code;
    if (code && ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)) throw new ProviderFailure('TRANSIENT', 'PROVIDER_UNREACHABLE', 'Provider is unreachable.');
    throw new ProviderFailure(name === 'TimeoutError' || name === 'AbortError' ? 'UNKNOWN' : 'TRANSIENT', 'PROVIDER_NETWORK', 'Provider did not respond.');
  }
  const body = await res.json().catch(() => ({})) as Record<string, any>;
  if (res.status === 429 || res.status >= 500) throw new ProviderFailure('TRANSIENT', 'PROVIDER_' + res.status, 'Provider is temporarily unavailable.');
  if (!res.ok) throw new ProviderFailure('PERMANENT', 'PROVIDER_REJECTED_' + res.status, 'Provider rejected the request.'); // body never echoed (may contain key hints)
  return body;
}
const num = (v: unknown) => Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : 0;
const openAiMessages = (req: InferRequest) => [{ role: 'system', content: req.system }, ...req.messages];

/** Bounded SSE parser. A broken accepted stream is UNKNOWN and must never be resent as a fresh paid request. */
async function streamingCompletion(url: string, headers: Record<string, string>, req: InferRequest): Promise<InferResult> {
  let response: Response;
  try { response = await fetch(url, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': req.idempotencyKey },
    body: JSON.stringify({ model: req.model, messages: openAiMessages(req), max_tokens: req.maxTokens, stream: true, stream_options: { include_usage: true } }), signal: AbortSignal.timeout(TIMEOUT_MS()) }); }
  catch { throw new ProviderFailure('UNKNOWN', 'PROVIDER_STREAM_UNKNOWN', 'Provider stream could not be established.'); }
  if (!response.ok) throw new ProviderFailure(response.status === 429 || response.status >= 500 ? 'TRANSIENT' : 'PERMANENT', 'PROVIDER_' + response.status, 'Provider rejected streaming.');
  const reader = response.body?.getReader();
  if (!reader) throw new ProviderFailure('UNKNOWN', 'PROVIDER_STREAM_UNKNOWN', 'Provider stream is unavailable.');
  const decoder = new TextDecoder(); let buffer = '', done = false;
  const result: InferResult = { requestId: '', text: '', usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, finishReason: '' };
  try {
    while (!done) {
      const part = await reader.read();
      if (part.done) break;
      buffer += decoder.decode(part.value, { stream: true });
      if (buffer.length > 1_000_000) throw new Error('FRAME_TOO_LARGE');
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') { done = true; break; }
        const event = JSON.parse(data);
        if (event.error) throw new Error('PROVIDER_STREAM_ERROR');
        result.requestId = String(event.id ?? result.requestId);
        const delta = event.choices?.[0]?.delta?.content;
        if (typeof delta === 'string') {
          result.text += delta;
          if (result.text.length > 1_000_000) throw new Error('OUTPUT_TOO_LARGE');
          await req.onDelta!(delta);
        }
        result.finishReason = event.choices?.[0]?.finish_reason ?? result.finishReason;
        if (event.usage) result.usage = { inputTokens: num(event.usage.prompt_tokens), outputTokens: num(event.usage.completion_tokens), cachedTokens: num(event.usage.prompt_tokens_details?.cached_tokens) };
      }
    }
    if (!done) throw new Error('INCOMPLETE_STREAM');
    return result;
  } catch { throw new ProviderFailure('UNKNOWN', 'PROVIDER_STREAM_UNKNOWN', 'Accepted stream ended without a verified complete response.'); }
  finally { await reader.cancel().catch(() => undefined); }
}

function openAiCompatible(code: string, base: (endpoint: string | null, model: string) => string, headers: (secret: string) => Record<string, string>): AiModelAdapter {
  return {
    code,
    async validateConnection(secret, endpoint) {
      try { await call(base(endpoint, 'gpt-4o-mini').replace(/\/chat\/completions.*$/, '/models'), { headers: headers(secret) }); return { ok: true, detail: 'Credentials accepted.' }; }
      catch (e) { return { ok: false, detail: e instanceof ProviderFailure ? e.code : 'VERIFY_FAILED' }; }
    },
    async infer(secret, endpoint, req) {
      if (req.onDelta && !req.json) return streamingCompletion(base(endpoint, req.model), headers(secret), req);
      const body = await call(base(endpoint, req.model), { method: 'POST', headers: { ...headers(secret), 'content-type': 'application/json', 'idempotency-key': req.idempotencyKey },
        body: JSON.stringify({ model: req.model, messages: openAiMessages(req), max_tokens: req.maxTokens, ...(req.json ? { response_format: { type: 'json_object' } } : {}) }) });
      return { requestId: String(body.id ?? ''), text: String(body.choices?.[0]?.message?.content ?? ''), finishReason: String(body.choices?.[0]?.finish_reason ?? ''),
        usage: { inputTokens: num(body.usage?.prompt_tokens), outputTokens: num(body.usage?.completion_tokens), cachedTokens: num(body.usage?.prompt_tokens_details?.cached_tokens) } };
    },
    async reconcile() { return 'UNKNOWN'; },
  };
}
const AZURE_ENDPOINT = /^https:\/\/[a-z0-9-]{2,64}\.openai\.azure\.com$/;
const ADAPTERS: Record<string, AiModelAdapter> = {
  OPENAI: { ...openAiCompatible('OPENAI', () => 'https://api.openai.com/v1/chat/completions', s => ({ authorization: 'Bearer ' + s })),
    async embed(secret, _endpoint, model, input) {
      const body = await call('https://api.openai.com/v1/embeddings', { method: 'POST', headers: { authorization: 'Bearer ' + secret, 'content-type': 'application/json' }, body: JSON.stringify({ model, input, encoding_format: 'float' }) });
      const vector = z.array(z.number().finite()).min(1).max(4096).parse(body.data?.[0]?.embedding);
      return { requestId: createHash('sha256').update(JSON.stringify(vector)).digest('hex'), vector, inputTokens: num(body.usage?.prompt_tokens) };
    },
    async transcribe(secret, _e, audio, mimeType, language, options) {
      const model = options?.model ?? process.env.AI_TRANSCRIBE_MODEL ?? 'whisper-1';
      if (options?.diarization && !model.includes('diarize')) throw new ProviderFailure('PERMANENT', 'DIARIZATION_ROUTE_REQUIRED', 'Select an approved diarization model route.');
      const form = new FormData(); form.set('file', new Blob([new Uint8Array(audio)], { type: mimeType }), 'audio'); form.set('model', model); if (language) form.set('language', language);
      if (options?.diarization) { form.set('response_format', 'diarized_json'); form.set('chunking_strategy', 'auto'); }
      const body = await call('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { authorization: 'Bearer ' + secret }, body: form });
      const segments = options?.diarization ? z.array(z.object({ speaker: z.string().max(100), start: z.number().nonnegative(), end: z.number().nonnegative(), text: z.string().max(100000) })).max(10000).parse(body.segments) : undefined;
      return { requestId: createHash('sha256').update(String(body.text ?? '')).digest('hex').slice(0, 24), text: String(body.text ?? ''), durationSeconds: num(body.duration), segments };
    },
    async generateImage(secret, _e, prompt, idempotencyKey) {
      const body = await call('https://api.openai.com/v1/images/generations', { method: 'POST', headers: { authorization: 'Bearer ' + secret, 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
        body: JSON.stringify({ model: process.env.AI_IMAGE_MODEL ?? 'gpt-image-1', prompt, size: '1024x1024' }) });
      const b64 = body.data?.[0]?.b64_json; if (!b64) throw new ProviderFailure('PERMANENT', 'IMAGE_EMPTY', 'Provider returned no image.');
      return { requestId: String(body.created ?? ''), bytes: Buffer.from(String(b64), 'base64'), mimeType: 'image/png' };
    } },
  AZURE_OPENAI: openAiCompatible('AZURE_OPENAI', (endpoint, model) => {
    if (!endpoint || !AZURE_ENDPOINT.test(endpoint)) throw new ProviderFailure('PERMANENT', 'ENDPOINT_NOT_ALLOWED', 'Azure endpoint must be https://<resource>.openai.azure.com.');
    return `${endpoint}/openai/deployments/${encodeURIComponent(model)}/chat/completions?api-version=${process.env.AZURE_OPENAI_API_VERSION ?? '2024-10-21'}`;
  }, s => ({ 'api-key': s })),
  OPENROUTER: openAiCompatible('OPENROUTER', () => 'https://openrouter.ai/api/v1/chat/completions', s => ({ authorization: 'Bearer ' + s })),
  ANTHROPIC: {
    code: 'ANTHROPIC',
    async validateConnection(secret) {
      try { await call('https://api.anthropic.com/v1/models', { headers: { 'x-api-key': secret, 'anthropic-version': '2023-06-01' } }); return { ok: true, detail: 'Credentials accepted.' }; }
      catch (e) { return { ok: false, detail: e instanceof ProviderFailure ? e.code : 'VERIFY_FAILED' }; }
    },
    async infer(secret, _e, req) {
      const body = await call('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': secret, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: req.model, max_tokens: req.maxTokens, system: req.system, messages: req.messages }) });
      return { requestId: String(body.id ?? ''), text: (body.content ?? []).filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text).join(''), finishReason: String(body.stop_reason ?? ''),
        usage: { inputTokens: num(body.usage?.input_tokens) + num(body.usage?.cache_read_input_tokens), outputTokens: num(body.usage?.output_tokens), cachedTokens: num(body.usage?.cache_read_input_tokens) } };
    },
    async reconcile() { return 'UNKNOWN'; },
  },
  GOOGLE_GEMINI: {
    code: 'GOOGLE_GEMINI',
    async validateConnection(secret) {
      try { await call('https://generativelanguage.googleapis.com/v1beta/models', { headers: { 'x-goog-api-key': secret } }); return { ok: true, detail: 'Credentials accepted.' }; }
      catch (e) { return { ok: false, detail: e instanceof ProviderFailure ? e.code : 'VERIFY_FAILED' }; }
    },
    async infer(secret, _e, req) {
      const body = await call(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(req.model)}:generateContent`, { method: 'POST', headers: { 'x-goog-api-key': secret, 'content-type': 'application/json' },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: req.system }] }, contents: req.messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
          generationConfig: { maxOutputTokens: req.maxTokens, ...(req.json ? { responseMimeType: 'application/json' } : {}) } }) });
      const parts = body.candidates?.[0]?.content?.parts ?? [];
      return { requestId: String(body.responseId ?? ''), text: parts.map((p: { text?: string }) => p.text ?? '').join(''), finishReason: String(body.candidates?.[0]?.finishReason ?? ''),
        usage: { inputTokens: num(body.usageMetadata?.promptTokenCount), outputTokens: num(body.usageMetadata?.candidatesTokenCount), cachedTokens: num(body.usageMetadata?.cachedContentTokenCount) } };
    },
    async reconcile() { return 'UNKNOWN'; },
  },
};
/**
 * Deterministic sandbox (non-production only, AI_SANDBOX_ENABLED=true) exposing transient/permanent/timeout/injection scenarios
 * through magic markers so integration tests can exercise retry, fallback and reconciliation paths without real providers.
 */
const sandbox: AiModelAdapter = {
  code: 'SANDBOX',
  async validateConnection() { return { ok: true, detail: 'Sandbox.' }; },
  async infer(_s, _e, req) {
    const last = req.messages.at(-1)?.content ?? '';
    if (last.includes('[[transient]]')) throw new ProviderFailure('TRANSIENT', 'PROVIDER_503', 'Sandbox transient failure.');
    if (last.includes('[[permanent]]')) throw new ProviderFailure('PERMANENT', 'PROVIDER_REJECTED_400', 'Sandbox permanent failure.');
    if (last.includes('[[timeout]]')) throw new ProviderFailure('UNKNOWN', 'PROVIDER_NETWORK', 'Sandbox timeout after acceptance.');
    const text = req.json ? (last.match(/\[\[json:(.*?)\]\]/s)?.[1] ?? '{}') : `Sandbox answer: ${last.slice(0, 200)}`;
    return { requestId: 'sbx_' + createHash('sha256').update(req.idempotencyKey).digest('hex').slice(0, 16), text, finishReason: 'stop',
      usage: { inputTokens: Math.ceil((req.system.length + req.messages.reduce((s, m) => s + m.content.length, 0)) / 4), outputTokens: Math.ceil(text.length / 4), cachedTokens: 0 } };
  },
  async reconcile() { return 'NOT_FOUND'; },
  async transcribe(_s, _e, audio) { return { requestId: 'sbx_tr', text: `Sandbox transcript (${audio.length} bytes)`, durationSeconds: 1 }; },
  async generateImage(_s, _e, prompt) { return { requestId: 'sbx_img', bytes: Buffer.from(`sandbox-image:${prompt}`), mimeType: 'image/png' }; },
};
let overrides: Record<string, AiModelAdapter> = {};
/** Test seam for sandbox adapters with deterministic scenarios (never used in production). */
export function setAiAdapters(next: Record<string, AiModelAdapter>) { overrides = next; }
export function adapterFor(code: string): AiModelAdapter {
  if (overrides[code]) return overrides[code];
  if (code === 'SANDBOX') {
    if (process.env.NODE_ENV === 'production' || process.env.AI_SANDBOX_ENABLED !== 'true') throw new AppError('DEPENDENCY_UNAVAILABLE', 'AI sandbox is disabled.', 503);
    return sandbox;
  }
  const adapter = ADAPTERS[code];
  if (!adapter) throw new AppError('DEPENDENCY_UNAVAILABLE', `No adapter for provider ${code}.`, 503);
  return adapter;
}
/** Secret resolution: platform connections use vault refs (env:NAME); BYOK keys are sealed at rest. Raw keys never leave this function. */
export function connectionSecret(conn: { vaultSecretRef: string | null; secretSealed: string | null }) {
  if (conn.secretSealed) { const v = decrypt(conn.secretSealed); if (!v) throw new AppError('DEPENDENCY_UNAVAILABLE', 'Connection secret is unavailable.', 503); return v; }
  return resolveSecret(conn.vaultSecretRef);
}
export const fingerprintSecret = (secret: string) => createHash('sha256').update(secret).digest('hex').slice(0, 16);
