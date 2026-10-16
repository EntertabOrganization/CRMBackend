import { connect as tlsConnect } from 'node:tls';
import { createHash, createHmac } from 'node:crypto';
import { AppError } from '../errors';
import type { Tx } from '../process-platform/context';
import { safeEqual, sha256 } from './kernel';

/**
 * Provider adapter registry (Shared-Contracts/06). Secrets are never stored in PostgreSQL:
 * a connection stores `credentialSecretRef` (e.g. `env:TWILIO_PRIMARY`) resolved by the secret
 * layer at call time. Unconfigured adapters fail closed with DEPENDENCY_UNAVAILABLE and never
 * report success. The SANDBOX adapter is deterministic and records every call for contract tests.
 */
export type ProviderContext = { workspaceId: string; connectionId: string; correlationId: string; idempotencyKey: string; secretRef?: string | null };
export type MarketingChannel = 'EMAIL' | 'SMS' | 'WHATSAPP' | 'VOICE';
export type SendResult = { accepted: boolean; retryable: boolean; externalMessageId?: string; errorCode?: string };
export interface MarketingSender {
  key: string; channel: MarketingChannel; capabilities: ReadonlySet<string>;
  send(ctx: ProviderContext, message: { deliveryId: string; destination: string; senderAddress: string; subject?: string | null; body: string; templateName?: string | null }): Promise<SendResult>;
  lookupDelivery(ctx: ProviderContext, deliveryId: string): Promise<{ state: 'UNKNOWN' | 'ACCEPTED' | 'DELIVERED' | 'FAILED'; externalMessageId?: string }>;
  verifyWebhook(headers: Headers, rawBody: string, secret: string): boolean;
}
export interface AdAudienceAdapter {
  platform: 'META' | 'GOOGLE';
  upsertAudience(ctx: ProviderContext, audience: { externalId?: string | null; name: string; addHashes: string[]; removeHashes: string[] }): Promise<{ externalId: string; rejectedCount: number; partial: boolean }>;
  pullMetrics(ctx: ProviderContext, window: { from: string; to: string }): Promise<ReadonlyArray<{ campaignId: string; spend: string; currency: string; clicks: number; impressions: number }>>;
}
export interface ShippingAdapter {
  key: string;
  quote(ctx: ProviderContext, request: { weightGrams: number; country: string; region: string }): Promise<{ amount: string; currency: string; validUntil: string }>;
  createShipment(ctx: ProviderContext, request: { reference: string }): Promise<{ externalRef: string; tracking?: string }>;
  getStatus(ctx: ProviderContext, externalRef: string): Promise<string>;
}
export interface DnsVerifier { txtRecords(hostname: string): Promise<string[]> }
export interface AiGateway { runScenario(input: { scenario: string; workspaceId: string; prompt: string; allowedBlocks: string[] }): Promise<{ modelId: string; output: unknown; inputTokens: number; outputTokens: number; costMicros: number }> }

export function resolveSecret(ref: string | null | undefined) {
  if (!ref) throw new AppError('DEPENDENCY_UNAVAILABLE', 'Provider credentials are not configured.', 503);
  const [scheme, name] = ref.split(':');
  const value = scheme === 'env' && name && /^[A-Z][A-Z0-9_]{1,80}$/.test(name) ? process.env[name] : undefined;
  if (!value) throw new AppError('DEPENDENCY_UNAVAILABLE', 'Provider credentials are unavailable in the secret store.', 503);
  return value;
}

/** Records every outbound provider effect; uniqueness on idempotencyKey prevents duplicate side effects. */
export async function recordProviderCall(tx: Tx, row: { workspaceId: string; module: string; provider: string; operation: string; idempotencyKey: string; reference?: string; campaignId?: string; recipientKey?: string; outcome: string; payload?: Record<string, unknown> }) {
  const prior = await tx.suiteProviderCall.findUnique({ where: { idempotencyKey: row.idempotencyKey } });
  if (prior) return { call: prior, duplicate: true };
  const call = await tx.suiteProviderCall.create({ data: { workspaceId: row.workspaceId, module: row.module, provider: row.provider, operation: row.operation, idempotencyKey: row.idempotencyKey,
    reference: row.reference ?? null, campaignId: row.campaignId ?? null, recipientKey: row.recipientKey ?? null, outcome: row.outcome, payload: (row.payload ?? {}) as object } });
  return { call, duplicate: false };
}

const sandboxBehavior = new Map<string, 'ACCEPT' | 'TIMEOUT_AFTER_ACCEPT' | 'QUOTA' | 'PERMANENT' | 'DOWN'>();
/** Deterministic sandbox failure injection used by provider-failure tests (keyed by connectionId). */
export function setSandboxBehavior(connectionId: string, behavior: 'ACCEPT' | 'TIMEOUT_AFTER_ACCEPT' | 'QUOTA' | 'PERMANENT' | 'DOWN') { sandboxBehavior.set(connectionId, behavior); }
const sandboxAccepted = new Map<string, string>();

function sandboxSender(channel: MarketingChannel): MarketingSender {
  return { key: 'SANDBOX', channel, capabilities: new Set(['SEND', 'STATUS', 'WEBHOOK']),
    async send(ctx, message) {
      const behavior = sandboxBehavior.get(ctx.connectionId) ?? 'ACCEPT';
      if (behavior === 'DOWN') return { accepted: false, retryable: true, errorCode: 'PROVIDER_UNAVAILABLE' };
      if (behavior === 'QUOTA') return { accepted: false, retryable: true, errorCode: 'PROVIDER_QUOTA' };
      if (behavior === 'PERMANENT') return { accepted: false, retryable: false, errorCode: 'INVALID_DESTINATION' };
      const externalMessageId = 'sbx_' + sha256(ctx.idempotencyKey).slice(0, 24);
      sandboxAccepted.set(message.deliveryId, externalMessageId);
      if (behavior === 'TIMEOUT_AFTER_ACCEPT') throw new AppError('DEPENDENCY_UNAVAILABLE', 'Provider timed out.', 503);
      return { accepted: true, retryable: false, externalMessageId };
    },
    async lookupDelivery(_ctx, deliveryId) { const id = sandboxAccepted.get(deliveryId); return id ? { state: 'ACCEPTED', externalMessageId: id } : { state: 'UNKNOWN' }; },
    verifyWebhook(headers, rawBody, secret) { const sig = headers.get('x-sandbox-signature') ?? ''; return safeEqual(sig, createHmac('sha256', secret).update(rawBody).digest('hex')); } };
}

async function postForm(url: string, auth: string, body: Record<string, string>) {
  const response = await fetch(url, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body), signal: AbortSignal.timeout(15000) });
  return { status: response.status, json: await response.json().catch(() => ({})) as Record<string, unknown> };
}
function classify(status: number): SendResult { return { accepted: false, retryable: status === 429 || status >= 500, errorCode: status === 429 ? 'PROVIDER_QUOTA' : status >= 500 ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_REJECTED' }; }

/** Twilio SMS/voice via REST; secret format `ACCOUNT_SID:AUTH_TOKEN`. */
function twilio(channel: 'SMS' | 'VOICE'): MarketingSender {
  return { key: 'TWILIO', channel, capabilities: new Set(['SEND', 'STATUS', 'WEBHOOK']),
    async send(ctx, message) {
      const [sid, token] = resolveSecret(ctx.secretRef).split(':');
      const auth = 'Basic ' + Buffer.from(sid + ':' + token).toString('base64');
      const body: Record<string, string> = channel === 'SMS' ? { To: message.destination, From: message.senderAddress, Body: message.body }
        : { To: message.destination, From: message.senderAddress, Twiml: '<Response><Say>' + message.body.replace(/[<>&]/g, '') + '</Say></Response>' };
      const result = await postForm(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/${channel === 'SMS' ? 'Messages' : 'Calls'}.json`, auth, body);
      return result.status < 300 ? { accepted: true, retryable: false, externalMessageId: String(result.json.sid ?? '') } : classify(result.status);
    },
    async lookupDelivery() { return { state: 'UNKNOWN' }; },
    verifyWebhook(headers, rawBody, secret) {
      const url = headers.get('x-original-url') ?? ''; const params = new URLSearchParams(rawBody);
      const data = url + [...params.keys()].sort().map(k => k + params.get(k)).join('');
      return safeEqual(headers.get('x-twilio-signature') ?? '', createHmac('sha1', secret.split(':')[1] ?? secret).update(data).digest('base64'));
    } };
}
/** Meta WhatsApp Cloud API: approved templates only. Secret format `PHONE_NUMBER_ID:ACCESS_TOKEN`. */
const whatsapp: MarketingSender = { key: 'META_WHATSAPP', channel: 'WHATSAPP', capabilities: new Set(['SEND_TEMPLATE', 'STATUS', 'WEBHOOK']),
  async send(ctx, message) {
    if (!message.templateName) return { accepted: false, retryable: false, errorCode: 'WHATSAPP_TEMPLATE_REQUIRED' };
    const [phoneId, token] = resolveSecret(ctx.secretRef).split(':');
    const response = await fetch(`https://graph.facebook.com/v20.0/${encodeURIComponent(phoneId)}/messages`, { method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: message.destination.replace('+', ''), type: 'template', template: { name: message.templateName, language: { code: 'en' } } }) });
    const json = await response.json().catch(() => ({})) as { messages?: { id: string }[] };
    return response.ok ? { accepted: true, retryable: false, externalMessageId: json.messages?.[0]?.id } : classify(response.status);
  },
  async lookupDelivery() { return { state: 'UNKNOWN' }; },
  verifyWebhook(headers, rawBody, secret) { return safeEqual(headers.get('x-hub-signature-256') ?? '', 'sha256=' + createHmac('sha256', secret.split(':').pop() ?? secret).update(rawBody).digest('hex')); } };

/** Amazon SES v2 SendEmail with SigV4. Secret format `REGION:ACCESS_KEY_ID:SECRET_ACCESS_KEY`. */
const ses: MarketingSender = { key: 'SES', channel: 'EMAIL', capabilities: new Set(['SEND', 'WEBHOOK']),
  async send(ctx, message) {
    const [region, accessKey, secretKey] = resolveSecret(ctx.secretRef).split(':');
    const host = `email.${region}.amazonaws.com`, path = '/v2/email/outbound-emails';
    const body = JSON.stringify({ FromEmailAddress: message.senderAddress, Destination: { ToAddresses: [message.destination] },
      Content: { Simple: { Subject: { Data: message.subject ?? '' }, Body: { Text: { Data: message.body } } } } });
    const now = new Date(), amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''), day = amzDate.slice(0, 8);
    const hash = (v: string) => createHash('sha256').update(v).digest('hex');
    const canonicalRequest = ['POST', path, '', 'content-type:application/json', 'host:' + host, 'x-amz-date:' + amzDate, '', 'content-type;host;x-amz-date', hash(body)].join('\n');
    const scope = `${day}/${region}/ses/aws4_request`, toSign = ['AWS4-HMAC-SHA256', amzDate, scope, hash(canonicalRequest)].join('\n');
    const kDate = createHmac('sha256', 'AWS4' + secretKey).update(day).digest(), kRegion = createHmac('sha256', kDate).update(region).digest();
    const kService = createHmac('sha256', kRegion).update('ses').digest(), kSigning = createHmac('sha256', kService).update('aws4_request').digest();
    const signature = createHmac('sha256', kSigning).update(toSign).digest('hex');
    const response = await fetch('https://' + host + path, { method: 'POST', body, signal: AbortSignal.timeout(15000), headers: { 'content-type': 'application/json', 'x-amz-date': amzDate,
      authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=content-type;host;x-amz-date, Signature=${signature}` } });
    const json = await response.json().catch(() => ({})) as { MessageId?: string };
    return response.ok ? { accepted: true, retryable: false, externalMessageId: json.MessageId } : classify(response.status);
  },
  async lookupDelivery() { return { state: 'UNKNOWN' }; },
  verifyWebhook() { return false; /* SNS signature verification requires certificate fetch; events are reconciled by authoritative lookup. */ } };

/** SMTP over implicit TLS (port 465) with AUTH PLAIN. Secret format `HOST:PORT:USER:PASSWORD`. */
const smtp: MarketingSender = { key: 'SMTP', channel: 'EMAIL', capabilities: new Set(['SEND']),
  async send(ctx, message) {
    const [host, port, user, ...rest] = resolveSecret(ctx.secretRef).split(':'); const password = rest.join(':');
    const lines = [`EHLO truecrm`, `AUTH PLAIN ${Buffer.from('\0' + user + '\0' + password).toString('base64')}`, `MAIL FROM:<${message.senderAddress}>`, `RCPT TO:<${message.destination}>`, 'DATA',
      `From: <${message.senderAddress}>\r\nTo: <${message.destination}>\r\nSubject: ${(message.subject ?? '').replace(/[\r\n]/g, ' ')}\r\nMessage-ID: <${message.deliveryId}@truecrm>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${message.body.replace(/^\./gm, '..')}\r\n.`, 'QUIT'];
    return new Promise<SendResult>(resolve => {
      const socket = tlsConnect({ host, port: Number(port || 465), servername: host, timeout: 15000 }); let step = -1, buffer = '';
      socket.on('data', chunk => { buffer += chunk.toString('utf8'); if (!/\r\n$/.test(buffer) || /^\d{3}-/m.test(buffer.split('\r\n').slice(-2)[0] ?? '')) return;
        const code = Number(buffer.slice(-200).trim().split('\r\n').pop()?.slice(0, 3)); buffer = '';
        if (code >= 400) { socket.destroy(); resolve({ accepted: false, retryable: code < 500, errorCode: code < 500 ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_REJECTED' }); return; }
        step++; if (step < lines.length) socket.write(lines[step] + '\r\n'); else { socket.end(); resolve({ accepted: true, retryable: false, externalMessageId: message.deliveryId }); } });
      socket.on('error', () => resolve({ accepted: false, retryable: true, errorCode: 'PROVIDER_UNAVAILABLE' }));
      socket.on('timeout', () => { socket.destroy(); resolve({ accepted: false, retryable: true, errorCode: 'PROVIDER_TIMEOUT' }); });
    });
  },
  async lookupDelivery() { return { state: 'UNKNOWN' }; },
  verifyWebhook() { return false; } };

export function marketingSender(provider: string, channel: MarketingChannel): MarketingSender {
  if (provider === 'SANDBOX') return sandboxSender(channel);
  if (provider === 'TWILIO' && (channel === 'SMS' || channel === 'VOICE')) return twilio(channel);
  if (provider === 'META_WHATSAPP' && channel === 'WHATSAPP') return whatsapp;
  if (provider === 'SES' && channel === 'EMAIL') return ses;
  if (provider === 'SMTP' && channel === 'EMAIL') return smtp;
  throw new AppError('PROVIDER_CAPABILITY_UNAVAILABLE', `${provider} does not support ${channel}.`, 409);
}
export const providerChannels: Record<string, MarketingChannel[]> = { SANDBOX: ['EMAIL', 'SMS', 'WHATSAPP', 'VOICE'], SMTP: ['EMAIL'], SES: ['EMAIL'], TWILIO: ['SMS', 'VOICE'], META_WHATSAPP: ['WHATSAPP'] };

const adSandboxFailures = new Map<string, number>();
export function setAdSandboxQuota(connectionId: string, failNextCalls: number) { adSandboxFailures.set(connectionId, failNextCalls); }
export function adAudienceAdapter(platform: 'META' | 'GOOGLE', sandbox: boolean): AdAudienceAdapter {
  if (sandbox) return { platform,
    async upsertAudience(ctx, audience) {
      const fails = adSandboxFailures.get(ctx.connectionId) ?? 0;
      if (fails > 0) { adSandboxFailures.set(ctx.connectionId, fails - 1); throw new AppError('PROVIDER_QUOTA', 'Ads API quota exceeded.', 429); }
      return { externalId: audience.externalId ?? 'sbx_aud_' + sha256(ctx.connectionId + audience.name).slice(0, 16), rejectedCount: 0, partial: false };
    },
    async pullMetrics() { return []; } };
  if (platform === 'META') return { platform,
    async upsertAudience(ctx, audience) {
      const [accountId, token] = resolveSecret(ctx.secretRef).split(':');
      let externalId = audience.externalId;
      if (!externalId) {
        const created = await fetch(`https://graph.facebook.com/v20.0/act_${encodeURIComponent(accountId)}/customaudiences`, { method: 'POST', signal: AbortSignal.timeout(20000), headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ name: audience.name, subtype: 'CUSTOM', customer_file_source: 'USER_PROVIDED_ONLY' }) });
        if (!created.ok) throw new AppError(created.status === 429 ? 'PROVIDER_QUOTA' : 'PROVIDER_REJECTED', 'Meta audience creation failed.', created.status === 429 ? 429 : 502);
        externalId = String(((await created.json()) as { id?: string }).id);
      }
      for (const [method, hashes] of [['POST', audience.addHashes], ['DELETE', audience.removeHashes]] as const) if (hashes.length) {
        const r = await fetch(`https://graph.facebook.com/v20.0/${externalId}/users`, { method, signal: AbortSignal.timeout(20000), headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ payload: { schema: 'EMAIL_SHA256', data: hashes } }) });
        if (!r.ok) throw new AppError(r.status === 429 ? 'PROVIDER_QUOTA' : 'PROVIDER_REJECTED', 'Meta audience sync failed.', r.status === 429 ? 429 : 502);
      }
      return { externalId: externalId!, rejectedCount: 0, partial: false };
    },
    async pullMetrics(ctx, window) {
      const [accountId, token] = resolveSecret(ctx.secretRef).split(':');
      const r = await fetch(`https://graph.facebook.com/v20.0/act_${encodeURIComponent(accountId)}/insights?level=campaign&fields=campaign_id,spend,clicks,impressions,account_currency&time_range=${encodeURIComponent(JSON.stringify({ since: window.from, until: window.to }))}`, { headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new AppError(r.status === 429 ? 'PROVIDER_QUOTA' : 'PROVIDER_REJECTED', 'Meta metrics import failed.', r.status === 429 ? 429 : 502);
      const json = await r.json() as { data?: { campaign_id: string; spend: string; clicks: string; impressions: string; account_currency: string }[] };
      return (json.data ?? []).map(row => ({ campaignId: row.campaign_id, spend: row.spend, currency: row.account_currency, clicks: Number(row.clicks), impressions: Number(row.impressions) }));
    } };
  return { platform,
    async upsertAudience() { throw new AppError('DEPENDENCY_UNAVAILABLE', 'Google Ads Customer Match requires an approved developer token and OAuth client; connector is not provisioned in this environment.', 503); },
    async pullMetrics() { throw new AppError('DEPENDENCY_UNAVAILABLE', 'Google Ads reporting requires an approved developer token and OAuth client.', 503); } };
}

/** Built-in delivery quoting (pickup/zone/weight). Carrier adapters are contract seams only. */
export function shippingAdapter(key: string): ShippingAdapter {
  if (key === 'BUILTIN') return { key,
    async quote() { return { amount: '0', currency: 'XXX', validUntil: new Date(Date.now() + 900000).toISOString() }; },
    async createShipment(_ctx, request) { return { externalRef: 'builtin_' + request.reference }; },
    async getStatus() { return 'PENDING'; } };
  throw new AppError('DEPENDENCY_UNAVAILABLE', `Carrier adapter ${key} is not integrated in this deployment.`, 503);
}

/** DNS TXT verification via DNS-over-HTTPS (configurable resolver). */
export const dnsVerifier: DnsVerifier = {
  async txtRecords(hostname) {
    const resolver = process.env.SITES_DOH_RESOLVER ?? 'https://cloudflare-dns.com/dns-query';
    try {
      const r = await fetch(`${resolver}?name=${encodeURIComponent('_truecrm-verify.' + hostname)}&type=TXT`, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(10000) });
      const json = await r.json() as { Answer?: { data: string }[] };
      return (json.Answer ?? []).map(a => a.data.replace(/^"|"$/g, ''));
    } catch { throw new AppError('DEPENDENCY_UNAVAILABLE', 'DNS resolver is unavailable.', 503); }
  } };
let dnsOverride: DnsVerifier | null = null;
export function setDnsVerifier(verifier: DnsVerifier | null) { dnsOverride = verifier; }
export function currentDnsVerifier() { return dnsOverride ?? dnsVerifier; }

/** AI gateway seam. No second model backend: the platform gateway URL must be configured. */
let aiOverride: AiGateway | null = null;
export function setAiGateway(gateway: AiGateway | null) { aiOverride = gateway; }
export function aiGateway(): AiGateway {
  if (aiOverride) return aiOverride;
  return { async runScenario(input) {
    const url = process.env.AI_GATEWAY_URL; if (!url) throw new AppError('DEPENDENCY_UNAVAILABLE', 'AI gateway is not configured.', 503);
    const r = await fetch(url.replace(/\/$/, '') + '/scenarios/run', { method: 'POST', signal: AbortSignal.timeout(60000), headers: { 'content-type': 'application/json', authorization: 'Bearer ' + resolveSecret(process.env.AI_GATEWAY_SECRET_REF) }, body: JSON.stringify(input) });
    if (!r.ok) throw new AppError('DEPENDENCY_UNAVAILABLE', 'AI gateway request failed.', 503);
    return await r.json() as Awaited<ReturnType<AiGateway['runScenario']>>;
  } };
}
