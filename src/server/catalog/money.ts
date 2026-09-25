import { canonicalDecimal } from '../fields/decimal';

/**
 * Exact decimal arithmetic for commercial values. Every number is a BigInt scaled by 10^8 (the storage scale of
 * NUMERIC(28,8)); nothing here ever touches binary floating point. Rounding is explicit: half-up (away from zero) at
 * the currency's minor-unit precision, applied to each computed monetary amount (line gross, discount, tax).
 */

const SCALE = 8;
const FACTOR = 10n ** BigInt(SCALE);
const HUNDRED = 100n * FACTOR;

/** ISO 4217 codes accepted for prices and rows. */
const CURRENCY_CODES = `AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF CLP CNY COP CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD UYU UZS VES VND VUV WST XAF XCD XOF XPF YER ZAR ZMW ZWL`.split(/\s+/);
const CURRENCY_SET = new Set(CURRENCY_CODES);
const ZERO_DECIMAL = new Set('BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX VND VUV XAF XOF XPF'.split(' '));
const THREE_DECIMAL = new Set('BHD IQD JOD KWD LYD OMR TND'.split(' '));

export function isValidCurrency(code: unknown): code is string {
  return typeof code === 'string' && CURRENCY_SET.has(code);
}

/** Minor-unit digits of a currency (2 for most, 0 for JPY-like, 3 for KWD-like). */
export function currencyDecimals(code: string): number {
  if (ZERO_DECIMAL.has(code)) return 0;
  if (THREE_DECIMAL.has(code)) return 3;
  return 2;
}

/** Canonical decimal string -> scaled BigInt; null when the input is not a valid decimal (max 8 fraction digits). */
export function toScaled(input: unknown): bigint | null {
  const canonical = canonicalDecimal(input);
  if (canonical === null) return null;
  const negative = canonical.startsWith('-');
  const [integerPart, fractionPart = ''] = canonical.replace('-', '').split('.');
  const scaled = BigInt(integerPart) * FACTOR + BigInt(fractionPart.padEnd(SCALE, '0'));
  return negative ? -scaled : scaled;
}

/** Scaled BigInt -> canonical decimal string. */
export function fromScaled(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const integerPart = abs / FACTOR;
  const fractionPart = (abs % FACTOR).toString().padStart(SCALE, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${integerPart}${fractionPart ? `.${fractionPart}` : ''}`;
}

/** Integer division rounded half-up (away from zero). */
export function roundDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new RangeError('Division by zero.');
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const quotient = (n * 2n + d) / (d * 2n);
  return negative ? -quotient : quotient;
}

/** round(a * b / c) to `decimals` fraction digits; a, b, c are scaled values, the result is scaled. */
export function mulDivRound(a: bigint, b: bigint, c: bigint, decimals: number): bigint {
  const unit = 10n ** BigInt(decimals);
  const units = roundDiv(a * b * unit, c * FACTOR);
  return units * 10n ** BigInt(SCALE - decimals);
}

export const scaledHundred = HUNDRED;

export type DiscountInput = { type: 'NONE' | 'PERCENT' | 'AMOUNT'; value: bigint };
export type TaxInput = { taxable: boolean; rate: bigint; included: boolean };

export type RowAmounts = {
  gross: bigint;
  discountAmount: bigint;
  subtotal: bigint;
  taxAmount: bigint;
  total: bigint;
};

/**
 * The single commercial calculation used by every row owner (Deal now, Estimate/Invoice later) so documents reconcile.
 *
 *   gross    = round(quantity * unitPrice)
 *   discount = PERCENT: round(gross * rate / 100) | AMOUNT: value (must be <= gross)
 *   net      = gross - discount
 *   tax-exclusive: tax = round(net * rate / 100),            subtotal = net,       total = net + tax
 *   tax-inclusive: tax = round(net * rate / (100 + rate)),   subtotal = net - tax, total = net
 */
export function calculateRow(quantity: bigint, unitPrice: bigint, discount: DiscountInput, tax: TaxInput, currency: string): RowAmounts {
  const decimals = currencyDecimals(currency);
  const gross = mulDivRound(quantity, unitPrice, FACTOR, decimals);
  let discountAmount = 0n;
  if (discount.type === 'PERCENT') discountAmount = mulDivRound(gross, discount.value, HUNDRED, decimals);
  else if (discount.type === 'AMOUNT') discountAmount = discount.value;
  if (discountAmount > gross) throw new RangeError('DISCOUNT_EXCEEDS_LINE');
  const net = gross - discountAmount;
  let taxAmount = 0n;
  let subtotal = net;
  let total = net;
  if (tax.taxable && tax.rate > 0n) {
    if (tax.included) {
      taxAmount = mulDivRound(net, tax.rate, HUNDRED + tax.rate, decimals);
      subtotal = net - taxAmount;
    } else {
      taxAmount = mulDivRound(net, tax.rate, HUNDRED, decimals);
      total = net + taxAmount;
    }
  }
  return { gross, discountAmount, subtotal, taxAmount, total };
}

/** True when the value has no more fraction digits than the currency allows (discount amounts must be representable). */
export function fitsCurrency(value: bigint, currency: string): boolean {
  const step = 10n ** BigInt(SCALE - currencyDecimals(currency));
  return value % step === 0n;
}

export function sumScaled(values: bigint[]): bigint {
  return values.reduce((acc, value) => acc + value, 0n);
}
