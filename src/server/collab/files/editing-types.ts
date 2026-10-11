export const EDIT_PROVIDERS = ['INTERNAL_DOCS', 'GOOGLE_DOCS', 'MICROSOFT_OFFICE', 'ONLYOFFICE', 'CUSTOM'] as const;
export type EditProviderName = typeof EDIT_PROVIDERS[number];
export type FileLock = {
  id: string; workspaceId: string; fileId: string; lockType: 'EDIT' | 'SYSTEM_PROCESS' | 'WORKFLOW';
  lockedByUserId: string | null; lockTokenHash: string; lockedAt: Date; expiresAt: Date; releasedAt: Date | null;
  version: number;
};
export type DocumentEditSession = {
  id: string; workspaceId: string; fileId: string; provider: EditProviderName; providerSessionId: string;
  userId: string; mode: 'COLLABORATIVE' | 'EXCLUSIVE_LOCK'; status: 'ACTIVE' | 'COMPLETED' | 'ABORTED' | 'EXPIRED';
  startedAt: Date; lastActivityAt: Date; endedAt: Date | null; expiresAt: Date; lockId: string | null;
  baseVersionId: string; resultVersionId: string | null; version: number;
  providerReady: boolean; saveRequestHash: string | null; uploadSessionId: string | null;
  cleanupRequired: boolean; cleanupClaimId: string | null; cleanupLeaseExpiresAt: Date | null;
  cleanupNextAttemptAt: Date | null; cleanupAttempts: number; cleanupErrorCode: string | null;
};
