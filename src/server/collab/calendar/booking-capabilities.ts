import { createHash, createHmac } from 'node:crypto';
import { AppError } from '../../errors';
import type { CalendarBooking } from './booking-types';

export type BookingPurpose = 'cancel' | 'reschedule';
export const bookingTokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
/** Deterministic receipts permit retries without storing plaintext guest credentials. */
export function bookingToken(row: Pick<CalendarBooking, 'workspaceId' | 'id' | 'tokenNonce' | 'tokenGeneration' | 'tokenExpiresAt'>, purpose: BookingPurpose) {
  const secret = process.env.BOOKING_TOKEN_SECRET ?? (process.env.NODE_ENV === 'test'
    ? 'booking-test-secret-minimum-32-characters' : process.env.JWT_ACCESS_SECRET);
  if (!secret || Buffer.byteLength(secret) < 32) throw new AppError('BOOKING_UNAVAILABLE', 'Booking capability signing is unavailable.', 503);
  return createHmac('sha256', secret).update(JSON.stringify(['booking-v1', row.workspaceId, row.id, purpose,
    row.tokenNonce, row.tokenGeneration, row.tokenExpiresAt.toISOString()])).digest('base64url');
}
