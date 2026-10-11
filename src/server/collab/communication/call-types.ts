export type CommunicationCall = {
  id: string; workspaceId: string; chatId: string | null; collabId: string | null; callType: 'AUDIO' | 'VIDEO'; title: string | null;
  startedByUserId: string; status: 'RINGING' | 'ACTIVE' | 'ENDED' | 'FAILED' | 'CANCELLED';
  provider: string; providerRoomId: string | null; errorCode: string | null; recordingEnabled: boolean; recordingFileId: string | null;
  inviteeUserIds: string[]; idempotencyKey: string | null; startedAt: Date; endedAt: Date | null; endedByUserId: string | null;
  version: number; createdAt: Date; updatedAt: Date;
};
export type CommunicationCallParticipant = {
  id: string; workspaceId: string; callId: string; userId: string | null; externalGuestId: string | null; displayName: string | null;
  role: 'HOST' | 'PARTICIPANT' | 'GUEST'; status: 'INVITED' | 'JOINED' | 'LEFT'; joinedAt: Date | null; leftAt: Date | null;
};
/** Call-scoped guest access: a hashed secret valid only for this call while it is live; it confers no Chat or Workspace access. */
export type CommunicationCallInvitation = {
  id: string; workspaceId: string; callId: string; displayName: string; email: string | null; tokenHash: string;
  expiresAt: Date; revokedAt: Date | null; createdByUserId: string; createdAt: Date;
};
