export type CalendarResource = {
  id: string; workspaceId: string; createdByUserId: string; type: 'ROOM' | 'EQUIPMENT' | 'OTHER';
  name: string; description: string | null; capacity: number | null; timezone: string;
  isExclusive: boolean; isActive: boolean; isDeleted: boolean;
  version: number; createdAt: Date; updatedAt: Date;
};
export type CalendarResourceBooking = {
  id: string; workspaceId: string; resourceId: string; eventId: string;
  recurrenceId?: string; seriesBookingId?: string | null;
  startAt: Date; endAt: Date; exclusive: boolean; status: 'ACTIVE' | 'CANCELLED';
  createdAt: Date; updatedAt: Date;
};
