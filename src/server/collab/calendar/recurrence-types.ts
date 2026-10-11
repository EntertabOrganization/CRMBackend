import type { RecurrenceDefinition } from './recurrence-engine';
export type CalendarRecurrenceRule = RecurrenceDefinition & {
  id: string; workspaceId: string; eventId: string; isDeleted: boolean;
  version: number; createdAt: Date; updatedAt: Date;
};
export type CalendarRecurrenceException = {
  id: string; workspaceId: string; recurrenceRuleId: string; recurrenceId: string;
  exceptionType: 'CANCELLED' | 'MODIFIED'; overrideEventId: string | null;
  createdAt: Date; updatedAt: Date;
};
/** Sparse THISANDFUTURE edits; nullable schedule values inherit the preceding range or series. */
export type CalendarRecurrenceRange = {
  id: string; workspaceId: string; recurrenceRuleId: string; recurrenceId: string;
  title: string | null; hasDescription: boolean; description: string | null;
  hasLocation: boolean; location: string | null; sourceTimezone: string | null;
  status: 'CONFIRMED' | 'TENTATIVE' | null; busyStatus: 'FREE' | 'BUSY' | null;
  shiftMilliseconds: number | null; durationMilliseconds: number | null;
  createdAt: Date; updatedAt: Date;
};
export type CalendarRecurrenceState = {
  calendarRecurrenceRules: CalendarRecurrenceRule[];
  calendarRecurrenceExceptions: CalendarRecurrenceException[];
  calendarRecurrenceRanges: CalendarRecurrenceRange[];
  calendarEventReminders: CalendarEventReminder[];
};
export type CalendarEventReminder = {
  id: string; workspaceId: string; eventId: string; attendeeUserId: string;
  recurrenceRuleId: string | null; recurrenceId: string | null;
  offsetSeconds: number | null; remindAt: Date | null; dueAt: Date | null;
  isSeries: boolean; seriesReminderId: string | null; isSeriesOverride: boolean;
  recurrenceOrdinal: number | null; sourceRuleVersion: number | null; sourceEventVersion: number | null;
  cursorRecurrenceId: string | null; cursorOrdinal: number; cursorRuleVersion: number | null; scanComplete: boolean;
  materializedAt: Date | null; cursorEventVersion: number | null;
  channel: 'IN_APP' | 'EMAIL' | 'PUSH'; status: 'SCHEDULED' | 'SENT' | 'CANCELLED' | 'FAILED';
  deliveryGeneration: number; attempts: number; nextAttemptAt: Date | null;
  claimToken: string | null; leaseExpiresAt: Date | null;
  sentAt: Date | null; deliveryReference: string | null; lastErrorCode: string | null;
  version: number; createdAt: Date; updatedAt: Date;
};
export const emptyCalendarRecurrenceState = (): CalendarRecurrenceState => ({
  calendarRecurrenceRules: [], calendarRecurrenceExceptions: [], calendarRecurrenceRanges: [], calendarEventReminders: [],
});
