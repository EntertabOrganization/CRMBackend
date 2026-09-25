const SENSITIVE_KEY = /(secret|token|password|passwd|api[-_]?key|credential|authorization|cookie|signature)/i;
const MAX_STRING = 2000;

/**
 * Deep-copies a value for logs, dry-run previews and API responses: credential-looking keys are replaced, every known secret
 * value is scrubbed from strings, and long strings are truncated. Nothing here can grow unbounded.
 */
export function redact<T>(value: T, knownSecrets: string[] = [], depth = 0): T {
  if (depth > 8) return '[TRUNCATED]' as unknown as T;
  if (typeof value === 'string') {
    let text: string = value;
    for (const secret of knownSecrets) if (secret.length >= 4) text = text.split(secret).join('[REDACTED]');
    return (text.length > MAX_STRING ? `${text.slice(0, MAX_STRING)}…` : text) as unknown as T;
  }
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => redact(item, knownSecrets, depth + 1)) as unknown as T;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      // A reference NAME (secretRef) is not a credential, so it stays visible; its value never appears anywhere.
      out[key] = SENSITIVE_KEY.test(key) && !/ref$/i.test(key) ? '[REDACTED]' : redact(inner, knownSecrets, depth + 1);
    }
    return out as T;
  }
  return value;
}

export function safeMessage(error: unknown, knownSecrets: string[] = []): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redact(raw, knownSecrets).slice(0, 500);
}
