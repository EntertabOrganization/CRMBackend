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
};
export const emptyCalendarRecurrenceState = (): CalendarRecurrenceState => ({
  calendarRecurrenceRules: [], calendarRecurrenceExceptions: [], calendarRecurrenceRanges: [],
});
