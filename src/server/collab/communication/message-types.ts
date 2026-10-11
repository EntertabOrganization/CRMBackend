export const MESSAGE_TYPES = ['TEXT', 'FILE', 'VOICE', 'VIDEO', 'SYSTEM'] as const;

/** Durable Message. `sequence` is a per-Chat monotonic position used for read positions and missed-realtime recovery. */
export type ChatMessage = {
  id: string; workspaceId: string; chatId: string; sequence: number;
  senderType: 'USER' | 'SYSTEM' | 'BOT'; senderId: string | null; clientMessageId: string; requestHash: string;
  messageType: typeof MESSAGE_TYPES[number]; body: string | null; fileIds: string[]; replyToMessageId: string | null;
  status: 'ACTIVE' | 'DELETED'; sentAt: Date; editedAt: Date | null; deletedAt: Date | null; deletedByUserId: string | null;
  version: number; createdAt: Date; updatedAt: Date;
};
/** Immutable pre-edit body; `versionNumber` is the Message version that carried this body. */
export type ChatMessageVersion = { id: string; workspaceId: string; messageId: string; versionNumber: number; body: string | null; editedByUserId: string; createdAt: Date };
export type ChatMessageReaction = { id: string; workspaceId: string; messageId: string; userId: string; reaction: string; createdAt: Date };
export type ChatMessagePin = { id: string; workspaceId: string; chatId: string; messageId: string; pinnedByUserId: string; createdAt: Date };
export type ChatMessageFavorite = { id: string; workspaceId: string; messageId: string; userId: string; createdAt: Date };
/** Exact receipt for small contexts; the standard read model is the per-user position in ChatReadState. */
export type ChatMessageRead = { id: string; workspaceId: string; chatId: string; messageId: string; userId: string; readAt: Date };
export type ChatReadState = { id: string; workspaceId: string; chatId: string; userId: string; lastReadSequence: number; lastReadMessageId: string | null; updatedAt: Date };
export type ChatDraft = { id: string; workspaceId: string; chatId: string; userId: string; body: string; replyToMessageId: string | null; version: number; createdAt: Date; updatedAt: Date };
export type CommunicationBinding = {
  id: string; workspaceId: string; sourceType: 'CHAT_MESSAGE'; sourceId: string; chatId: string;
  targetType: 'TASK' | 'CALENDAR_EVENT'; targetId: string; createdByUserId: string; createdAt: Date;
};
