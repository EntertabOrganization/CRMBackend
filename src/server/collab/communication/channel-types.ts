export const CHANNEL_ROLES = ['OWNER', 'ADMIN', 'PUBLISHER', 'SUBSCRIBER'] as const;
export type ChannelRole = typeof CHANNEL_ROLES[number];

export type Channel = {
  id: string; workspaceId: string; name: string; description: string | null; visibility: 'PUBLIC' | 'PRIVATE';
  commentPolicy: 'MEMBERS' | 'PUBLISHERS' | 'DISABLED'; ownerUserId: string; status: 'ACTIVE' | 'ARCHIVED';
  isDeleted: boolean; deletedAt: Date | null; createdByUserId: string; version: number; createdAt: Date; updatedAt: Date;
};
/** Role assignment for one user; membership itself comes from active, currently valid sources. */
export type ChannelMember = { id: string; workspaceId: string; channelId: string; userId: string; role: ChannelRole; joinedAt: Date; leftAt: Date | null };
/**
 * MANUAL/SYSTEM sources name one user. DEPARTMENT/PROJECT sources have no user: they link the Channel to a group whose
 * current members are evaluated live, so joins and departures in the owning module apply without a sync step.
 */
export type ChannelMembershipSource = {
  id: string; workspaceId: string; channelId: string; userId: string | null; sourceType: 'MANUAL' | 'DEPARTMENT' | 'PROJECT' | 'SYSTEM';
  sourceId: string; role: ChannelRole; active: boolean; createdAt: Date; updatedAt: Date;
};
export type ChannelPost = {
  id: string; workspaceId: string; channelId: string; authorUserId: string; title: string | null; body: string | null;
  status: 'PUBLISHED' | 'DELETED'; publishedAt: Date; editedAt: Date | null; deletedAt: Date | null; deletedByUserId: string | null;
  version: number; createdAt: Date; updatedAt: Date;
};
export type ChannelComment = {
  id: string; workspaceId: string; channelId: string; postId: string; authorUserId: string; body: string | null;
  status: 'ACTIVE' | 'DELETED'; editedAt: Date | null; deletedAt: Date | null; deletedByUserId: string | null;
  version: number; createdAt: Date; updatedAt: Date;
};
