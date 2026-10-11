export const SYNC_PROVIDERS = ['GOOGLE', 'MICROSOFT', 'ICS'] as const;

export type CalendarSyncConnection = {
  id: string; workspaceId: string; userId: string; calendarId: string; provider: typeof SYNC_PROVIDERS[number]; name: string;
  externalCalendarId: string; accountEmail: string | null; status: 'ACTIVE' | 'AUTH_REQUIRED' | 'DISCONNECTED';
  syncCursor: string | null; lastSyncedAt: Date | null; lastError: string | null; failureCount: number;
  claimId: string | null; leaseExpiresAt: Date | null; version: number; createdAt: Date; updatedAt: Date;
};
/** Integration-owned opaque reference to provider credentials held by the sync broker; never part of Calendar payloads. */
export type CalendarSyncCredential = { id: string; workspaceId: string; connectionId: string; provider: string; credentialRef: string; createdAt: Date; revokedAt: Date | null };
export type CalendarSyncMapping = {
  id: string; workspaceId: string; connectionId: string; localEventId: string; externalCalendarId: string; externalEventId: string;
  externalVersion: string | null; localVersionAtLastSync: number; lastDirection: 'INBOUND' | 'OUTBOUND'; lastSyncedAt: Date;
  version: number; createdAt: Date; updatedAt: Date;
};
export type CalendarSyncConflict = {
  id: string; workspaceId: string; connectionId: string; mappingId: string; localEventId: string;
  localSnapshotJson: Record<string, unknown>; externalSnapshotJson: Record<string, unknown>; externalVersion: string; localVersion: number;
  status: 'OPEN' | 'RESOLVED'; resolution: 'LOCAL' | 'EXTERNAL' | 'MERGED' | 'IGNORED' | null; resolvedByUserId: string | null; resolvedAt: Date | null;
  version: number; createdAt: Date; updatedAt: Date;
};

/** Provider-neutral event shape exchanged with the sync broker (and produced by the ICS parser). */
export type ExternalCalendarEvent = {
  externalEventId: string; etag: string; status: 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED'; title: string; description: string | null; location: string | null;
  isAllDay: boolean; startAt: string | null; endAt: string | null; startDate: string | null; endDate: string | null; sourceTimezone: string | null;
  origin?: { connectionId: string; localVersion: number } | null;
};
export type OutboundCalendarEvent = Omit<ExternalCalendarEvent, 'externalEventId' | 'etag'> & { localEventId: string; localVersion: number; rrule: string | null };
