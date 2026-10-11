import type { WorkingSchedule } from './availability-types';
export type CalendarBookingPage = {
  id: string; workspaceId: string; ownerUserId: string; calendarId: string; createdByUserId: string;
  attendeeUserIds?: string[]; resourceIds?: string[];
  title: string; slug: string; status: 'DRAFT' | 'PUBLISHED' | 'UNPUBLISHED';
  bookingMode: 'AUTO_CONFIRM' | 'REQUIRE_APPROVAL'; durationMinutes: number;
  timezonePolicy: 'HOST' | 'INVITEE'; timezone: string;
  requireName: true; requireEmail: true; requirePhone: boolean;
  minNoticeMinutes: number; maxAdvanceDays: number; bufferBeforeMinutes: number; bufferAfterMinutes: number;
  isDeleted: boolean; version: number; createdAt: Date; updatedAt: Date;
};
export type CalendarBookingPageRules = WorkingSchedule & { pageId: string };
export type CalendarAvailabilityEpoch = { id: string; workspaceId: string; epoch: number };
export type CalendarBooking = {
  id: string; workspaceId: string; bookingPageId: string; ownerUserId: string; calendarId: string; eventId: string | null;
  attendeeUserIds?: string[]; resourceIds?: string[];
  guestName: string; guestEmail: string; guestPhone: string | null; startAt: Date; endAt: Date;
  reservedStartAt: Date; reservedEndAt: Date; status: 'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'COMPLETED' | 'NO_SHOW';
  idempotencyKey: string; requestHash: string; tokenNonce: string; tokenGeneration: number; tokenExpiresAt: Date;
  cancellationTokenHash: string | null; rescheduleTokenHash: string | null;
  publicReceiptRevoked?: boolean;
  sourceEpoch: number; pageVersion: number; rulesVersion: number;
  version: number; createdAt: Date; updatedAt: Date;
};
