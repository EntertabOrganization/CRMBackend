/**
 * Exact decimal helpers. Custom-field DECIMAL/MONEY values are carried as canonical decimal strings so precision is
 * never lost to binary floating point. Scale is fixed at 8 fractional digits (matches numeric(28,8) storage).
 */
export const DECIMAL_SCALE = 8;
export const DECIMAL_MAX_INTEGER_DIGITS = 20;
const SCALE_FACTOR = 10n ** BigInt(DECIMAL_SCALE);
const DECIMAL_PATTERN = /^[+-]?(\d+)(?:\.(\d+))?$/;

/** Parses a number or numeric string into a canonical decimal string, or null when it is not a valid decimal. */
export function canonicalDecimal(input: unknown, maxScale = DECIMAL_SCALE): string | null {
  let text: string;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null;
    text = Math.abs(input) >= 1e21 || (input !== 0 && Math.abs(input) < 1e-7) ? input.toFixed(DECIMAL_SCALE) : String(input);
  } else if (typeof input === 'string') {
    text = input.trim();
  } else {
    return null;
  }
  const match = DECIMAL_PATTERN.exec(text);
  if (!match) return null;
  const integerPart = match[1].replace(/^0+(?=\d)/, '');
  const fractionPart = (match[2] ?? '').replace(/0+$/, '');
  if (integerPart.length > DECIMAL_MAX_INTEGER_DIGITS) return null;
  if (fractionPart.length > Math.min(maxScale, DECIMAL_SCALE)) return null;
  const negative = text.startsWith('-') && (integerPart !== '0' || fractionPart !== '');
  return `${negative ? '-' : ''}${integerPart}${fractionPart ? `.${fractionPart}` : ''}`;
}

/** Scaled BigInt used for exact comparisons. Returns null for non-numeric input. */
export function decimalToScaled(input: unknown): bigint | null {
  const canonical = canonicalDecimal(typeof input === 'number' ? Number(input.toFixed(DECIMAL_SCALE)) : input);
  if (canonical === null) return null;
  const negative = canonical.startsWith('-');
  const [integerPart, fractionPart = ''] = canonical.replace('-', '').split('.');
  const scaled = BigInt(integerPart) * SCALE_FACTOR + BigInt(fractionPart.padEnd(DECIMAL_SCALE, '0'));
  return negative ? -scaled : scaled;
}

export function compareDecimals(left: unknown, right: unknown): number | null {
  const a = decimalToScaled(left);
  const b = decimalToScaled(right);
  if (a === null || b === null) return null;
  return a === b ? 0 : a < b ? -1 : 1;
}
