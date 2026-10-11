export const FEED_POST_TYPES = ['STANDARD', 'ANNOUNCEMENT', 'APPRECIATION', 'POLL'] as const;
export const FEED_RECIPIENT_TYPES = ['WORKSPACE', 'USER', 'DEPARTMENT', 'PROJECT'] as const;

export type FeedPost = {
  id: string; workspaceId: string; authorUserId: string; postType: typeof FEED_POST_TYPES[number]; title: string | null; body: string | null;
  status: 'DRAFT' | 'PUBLISHED' | 'DELETED'; statusBeforeDelete: 'DRAFT' | 'PUBLISHED' | null; requiresAcknowledgement: boolean;
  mentionUserIds: string[]; isPinned: boolean; publishedAt: Date | null; editedAt: Date | null; deletedAt: Date | null; deletedByUserId: string | null;
  version: number; createdAt: Date; updatedAt: Date;
};
/** Normal posts resolve recipients live; WORKSPACE has no recipientId. */
export type FeedPostRecipient = { id: string; workspaceId: string; postId: string; recipientType: typeof FEED_RECIPIENT_TYPES[number]; recipientId: string | null };
/** Announcement audience frozen at publication: the stable denominator for read/acknowledgement metrics. */
export type FeedAudienceSnapshot = { id: string; workspaceId: string; postId: string; userId: string; reason: string; publishedAt: Date };
export type FeedComment = {
  id: string; workspaceId: string; postId: string; authorUserId: string; body: string | null; status: 'ACTIVE' | 'DELETED';
  editedAt: Date | null; deletedAt: Date | null; deletedByUserId: string | null; version: number; createdAt: Date; updatedAt: Date;
};
export type FeedReaction = { id: string; workspaceId: string; postId: string; userId: string; reaction: string; createdAt: Date };
export type FeedFavorite = { id: string; workspaceId: string; postId: string; userId: string; createdAt: Date };
export type FeedRead = { id: string; workspaceId: string; postId: string; userId: string; readAt: Date };
export type FeedAcknowledgement = { id: string; workspaceId: string; postId: string; userId: string; acknowledgedAt: Date };
export type FeedPoll = {
  id: string; workspaceId: string; postId: string; question: string; isAnonymous: boolean; allowMultiple: boolean;
  closesAt: Date | null; createdByUserId: string; createdAt: Date;
};
export type FeedPollOption = { id: string; workspaceId: string; pollId: string; label: string; position: number };
/** Voter identity is stored only to enforce one vote and allow retraction; anonymous polls never expose it. */
export type FeedPollVote = { id: string; workspaceId: string; pollId: string; optionId: string; userId: string; createdAt: Date };
