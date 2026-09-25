import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class EgressError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

export type EgressRequest = {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
};

export type EgressResponse = { status: number; ok: boolean; bytes: number };

export interface EgressPort {
  send(request: EgressRequest): Promise<EgressResponse>;
}

const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_REDIRECTS = 3;
const BLOCKED_HOSTS = /(^|\.)(localhost|local|internal|localdomain|intranet|corp|home|lan)$/i;

function ipv4Parts(address: string): number[] | null {
  const parts = address.split('.').map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null;
}

/** True for anything that is not a routable public unicast address (loopback, private, link-local/metadata, CGNAT, multicast, ...). */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = ipv4Parts(address)!;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateAddress(mapped[1]);
    const first = parseInt(lower.split(':')[0] || '0', 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00 || lower.startsWith('64:ff9b:');
  }
  return true;
}

export type UrlPolicy = { allowHttp: boolean };

/** Static URL checks (no DNS): shape, protocol, credentials, port and literal/obvious internal hosts. Used at publish time too. */
export function assertSafeUrlShape(raw: string, policy: UrlPolicy): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EgressError('AUTOMATION_EGRESS_BLOCKED', 'The URL is not valid.');
  }
  if (url.protocol !== 'https:' && !(policy.allowHttp && url.protocol === 'http:')) throw new EgressError('AUTOMATION_EGRESS_BLOCKED', 'Only https URLs are allowed.');
  if (url.username || url.password) throw new EgressError('AUTOMATION_EGRESS_BLOCKED', 'URLs with embedded credentials are not allowed.');
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (![80, 443, 8443].includes(port)) throw new EgressError('AUTOMATION_EGRESS_BLOCKED', 'This port is not allowed.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) ? isPrivateAddress(host) : BLOCKED_HOSTS.test(host) || host === 'metadata' || !host.includes('.')) {
    throw new EgressError('AUTOMATION_EGRESS_BLOCKED', 'This destination is not allowed.');
  }
  return url;
}

export type Resolver = (hostname: string) => Promise<string[]>;

const defaultResolver: Resolver = async (hostname) => (await dnsLookup(hostname, { all: true })).map((entry) => entry.address);

/**
 * Controlled HTTP egress for Automation: https only, no internal/private/metadata destinations (checked on the URL and on
 * every resolved address, and again on each redirect), bounded time, bounded response size, no secrets in errors. The
 * fetch implementation and resolver are injectable so the policy is fully testable without network access.
 */
export class SafeHttpEgress implements EgressPort {
  constructor(
    private readonly options: { fetchImpl?: typeof fetch; resolver?: Resolver; allowHttp?: () => boolean } = {},
  ) {}

  private get policy(): UrlPolicy {
    return { allowHttp: this.options.allowHttp ? this.options.allowHttp() : process.env.AUTOMATION_ALLOW_HTTP === '1' };
  }

  async assertDestination(raw: string): Promise<URL> {
    const url = assertSafeUrlShape(raw, this.policy);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!isIP(host)) {
      let addresses: string[];
      try {
        addresses = await (this.options.resolver ?? defaultResolver)(host);
      } catch {
        throw new EgressError('AUTOMATION_EGRESS_UNREACHABLE', 'The host name could not be resolved.', true);
      }
      if (addresses.length === 0 || addresses.some(isPrivateAddress)) throw new EgressError('AUTOMATION_EGRESS_BLOCKED', 'This destination resolves to a non-public address.');
    }
    return url;
  }

  async send(request: EgressRequest): Promise<EgressResponse> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    let target = request.url;
    let method = request.method;
    let body = request.body;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const url = await this.assertDestination(target);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), request.timeoutMs);
      try {
        const response = await fetchImpl(url.toString(), { method, headers: request.headers, body: method === 'GET' ? undefined : body, redirect: 'manual', signal: controller.signal });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          if (!location) throw new EgressError('AUTOMATION_EGRESS_FAILED', 'A redirect without a location was returned.');
          target = new URL(location, url).toString();
          if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
            method = 'GET';
            body = undefined;
          }
          await response.body?.cancel();
          continue;
        }
        const bytes = await this.drain(response);
        if (response.status === 429 || response.status >= 500) throw new EgressError('AUTOMATION_EGRESS_HTTP_ERROR', `The endpoint answered with HTTP ${response.status}.`, true);
        if (response.status >= 400) throw new EgressError('AUTOMATION_EGRESS_HTTP_ERROR', `The endpoint rejected the request with HTTP ${response.status}.`, false);
        return { status: response.status, ok: response.ok, bytes };
      } catch (error) {
        if (error instanceof EgressError) throw error;
        if ((error as { name?: string })?.name === 'AbortError') throw new EgressError('AUTOMATION_EGRESS_TIMEOUT', 'The request timed out.', true);
        throw new EgressError('AUTOMATION_EGRESS_FAILED', 'The request could not be completed.', true);
      } finally {
        clearTimeout(timer);
      }
    }
    throw new EgressError('AUTOMATION_EGRESS_FAILED', 'Too many redirects.');
  }

  /** Reads at most MAX_RESPONSE_BYTES; the body itself is never kept (only its size). */
  private async drain(response: Response): Promise<number> {
    const reader = response.body?.getReader();
    if (!reader) return 0;
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new EgressError('AUTOMATION_EGRESS_RESPONSE_TOO_LARGE', 'The response was larger than allowed.');
      }
    }
    return total;
  }
}
