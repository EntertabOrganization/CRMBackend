export const EVENT_STATUSES = ['CONFIRMED', 'TENTATIVE', 'CANCELLED'] as const;
export const ATTENDEE_RESPONSES = ['NEEDS_ACTION', 'ACCEPTED', 'TENTATIVE', 'DECLINED'] as const;
export type CalendarEvent = {
  id: string; workspaceId: string; calendarId: string; organizerUserId: string;
  title: string; description: string | null; location: string | null; isAllDay: boolean;
  startAt: Date | null; endAt: Date | null; startDate: string | null; endDate: string | null;
  sourceTimezone: string; status: typeof EVENT_STATUSES[number]; busyStatus: 'FREE' | 'BUSY';
  recurrenceRuleId: string | null; recurrenceParentEventId: string | null; recurrenceIdentity: string | null;
  statusBeforeCancel: 'CONFIRMED' | 'TENTATIVE' | null;
  cancelledAt: Date | null; isDeleted: boolean; deletedAt: Date | null;
  version: number; createdAt: Date; updatedAt: Date;
};
export type CalendarEventAttendee = {
  id: string; workspaceId: string; eventId: string; userId: string;
  response: typeof ATTENDEE_RESPONSES[number]; respondedAt: Date | null; removedAt: Date | null;
};
export type CalendarExternalGuest = {
  id: string; workspaceId: string; eventId: string; email: string; name: string | null;
  response: typeof ATTENDEE_RESPONSES[number]; inviteTokenHash: string | null; removedAt: Date | null; createdAt: Date;
};
export type CalendarEventBinding = {
  id: string; workspaceId: string; eventId: string; entityType: string; entityId: string;
  createdByUserId: string; createdAt: Date;
};
export type CalendarEventFile = { id: string; workspaceId: string; eventId: string; fileId: string; createdAt: Date };
export type CalendarEventHistory = {
  id: string; workspaceId: string; eventId: string; actorUserId: string | null;
  action: string; changes: Record<string, unknown>; occurredAt: Date;
};
export type MeetingRecord = {
  id: string; workspaceId: string; eventId: string; agenda: string | null; notes: string | null;
  updatedByUserId: string; version: number; createdAt: Date; updatedAt: Date;
};
export type MeetingDecision = {
  id: string; workspaceId: string; eventId: string; text: string; createdByUserId: string; createdAt: Date;
};
export type CalendarEventsState = {
  calendarEvents: CalendarEvent[]; calendarEventAttendees: CalendarEventAttendee[];
  calendarExternalGuests: CalendarExternalGuest[]; calendarEventBindings: CalendarEventBinding[];
  calendarEventFiles: CalendarEventFile[]; calendarEventHistory: CalendarEventHistory[];
  meetingRecords: MeetingRecord[]; meetingDecisions: MeetingDecision[];
};
export function emptyCalendarEventsState(): CalendarEventsState {
  return { calendarEvents: [], calendarEventAttendees: [], calendarExternalGuests: [], calendarEventBindings: [],
    calendarEventFiles: [], calendarEventHistory: [], meetingRecords: [], meetingDecisions: [] };
}
