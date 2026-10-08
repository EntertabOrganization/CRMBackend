export const CALENDAR_TYPES = ['PERSONAL', 'COMPANY', 'DEPARTMENT', 'PROJECT'] as const;
export const CALENDAR_LEVELS = ['VIEW', 'CREATE', 'EDIT_OWN', 'EDIT_ALL', 'MANAGE'] as const;
export const CALENDAR_SUBJECTS = ['USER', 'ROLE', 'DEPARTMENT', 'DEPARTMENT_TREE', 'PROJECT_ROLE', 'WORKSPACE'] as const;
export type CalendarType = typeof CALENDAR_TYPES[number];
export type CalendarLevel = typeof CALENDAR_LEVELS[number];
export type Calendar = {
  id: string; workspaceId: string; type: CalendarType; ownerUserId: string | null;
  departmentId: string | null; projectId: string | null; createdByUserId: string;
  name: string; description: string | null; timezone: string; colorPreference: string | null;
  isActive: boolean; isReadOnly: boolean; isDeleted: boolean; version: number; createdAt: Date; updatedAt: Date;
};
export type CalendarPermission = {
  id: string; workspaceId: string; calendarId: string;
  subjectType: typeof CALENDAR_SUBJECTS[number]; subjectId: string | null; level: CalendarLevel;
};
export type UserCalendarPreference = {
  id: string; workspaceId: string; calendarId: string; userId: string;
  colorPreference: string | null; isVisible: boolean; version: number; createdAt: Date; updatedAt: Date;
};
