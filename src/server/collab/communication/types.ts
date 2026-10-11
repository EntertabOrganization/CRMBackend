export type Chat = {
  id: string; workspaceId: string; type: 'DIRECT' | 'GROUP' | 'TASK' | 'PROJECT' | 'DEPARTMENT' | 'COLLAB'; title: string | null;
  linkedTaskId: string | null; linkedProjectId: string | null; createdByUserId: string;
  linkedDepartmentId?: string | null; linkedCollabId?: string | null;
  status: 'ACTIVE' | 'ARCHIVED'; version: number; createdAt: Date; updatedAt: Date;
};
export type ChatMember = {
  id: string; workspaceId: string; chatId: string; userId: string; role: 'MEMBER' | 'ADMIN' | 'BOT';
  joinedAt: Date; leftAt: Date | null; lastReadMessageId?: string | null;
};
export type ChatMembershipSource = {
  id: string; workspaceId: string; chatId: string; userId: string;
  sourceType: 'TASK' | 'PROJECT' | 'DEPARTMENT' | 'COLLAB' | 'MANUAL' | 'SYSTEM'; sourceId: string; active: boolean;
  createdAt: Date; updatedAt: Date;
};

export type DirectChatPair = { id: string; workspaceId: string; chatId: string; userAId: string; userBId: string };
/** Restricted resource authority owned by Collabs; invitation orchestration is separate. */
export type CollabSpace = {
  id: string; workspaceId: string; name: string; ownerUserId: string; status: 'ACTIVE' | 'ARCHIVED'; version: number;
  description?: string | null; createdByUserId?: string | null; archivedAt?: Date | null; createdAt?: Date; updatedAt?: Date;
};
/** External invitation. Only a SHA-256 hash of the secret is stored; resend rotates it and acceptance is single-use. */
export type CollabInvitation = {
  id: string; workspaceId: string; collabId: string; email: string; role: 'MEMBER' | 'GUEST'; tokenHash: string; expiresAt: Date;
  acceptedAt: Date | null; acceptedUserId: string | null; revokedAt: Date | null; invitedByUserId: string; sendCount: number;
  version: number; createdAt: Date; updatedAt: Date;
};
export type CollabSpaceMember = {
  id: string; workspaceId: string; collabId: string; userId: string; memberType: 'INTERNAL' | 'EXTERNAL';
  role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'GUEST'; status: 'INVITED' | 'ACTIVE' | 'REMOVED'; joinedAt: Date | null; leftAt: Date | null;
};
