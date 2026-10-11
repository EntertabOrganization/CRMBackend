export type ProjectFileStorage = {
  id: string; workspaceId: string; type: 'PERSONAL' | 'COMPANY' | 'PROJECT' | 'SYSTEM'; ownerUserId: string | null; projectId: string | null;
  name: string; isActive: boolean; isReadOnly: boolean; version: number; createdAt: Date; updatedAt: Date;
};
export type ProjectRootFolder = {
  id: string; workspaceId: string; storageId: string; parentFolderId: string | null; name: string; status: 'ACTIVE' | 'TRASHED';
  originalParentFolderId: string | null; trashedAt: Date | null; purgeAfter: Date | null; version: number; createdAt: Date; updatedAt: Date;
  publicShareVersion?: number;
};

export type FilePermissionAssignment = {
  id: string; workspaceId: string; resourceType: 'STORAGE' | 'FOLDER' | 'FILE'; resourceId: string;
  subjectType: 'USER' | 'ROLE' | 'DEPARTMENT' | 'DEPARTMENT_TREE' | 'PROJECT_ROLE' | 'WORKSPACE' | 'EXTERNAL_GUEST'; subjectId: string | null;
  permissionLevel: 'NONE' | 'READ' | 'ADD' | 'EDIT' | 'FULL'; inheritanceMode: 'INHERIT' | 'OVERRIDE';
};
export type StorageAccessSource = {
  id: string; workspaceId: string; storageId: string; userId: string; sourceType: 'PROJECT' | 'MANUAL' | 'SYSTEM';
  sourceId: string; permissionLevel: 'READ' | 'ADD' | 'EDIT' | 'FULL'; active: boolean; createdAt: Date; updatedAt: Date;
};
export type FilePublicLink = {
  id: string; workspaceId: string; resourceType: 'FILE' | 'FOLDER'; resourceId: string;
  tokenHash: string; permissionMode: 'VIEW' | 'DOWNLOAD'; passwordHash: string | null;
  expiresAt: Date; maxDownloads: number | null; downloadCount: number; accessCount: number;
  includeChildren: boolean; isActive: boolean; createdByUserId: string; revokedAt: Date | null;
  resourceShareVersion: number; version: number; createdAt: Date; updatedAt: Date;
};
export type DriveFile = {
  id: string; workspaceId: string; storageId: string; folderId: string; name: string; extension: string; mimeType: string;
  currentVersionId: string | null; status: 'PROCESSING' | 'ACTIVE' | 'QUARANTINED' | 'BLOCKED' | 'TRASHED';
  sizeBytesCurrent: number; version: number; trashedAt: Date | null; purgeAfter: Date | null;
  originalFolderId: string | null; statusBeforeTrash: DriveFile['status'] | null;
  publicShareVersion: number; createdAt: Date; updatedAt: Date;
};
export type DriveFileVersion = {
  id: string; workspaceId: string; fileId: string; versionNumber: number; objectKey: string; sizeBytes: number;
  checksum: string; mimeType: string; createdByUserId: string; createdAt: Date; processedAt: Date | null; scanStatus: 'PENDING' | 'CLEAN' | 'BLOCKED' | 'ERROR';
};
export type UploadSession = {
  editSessionId?: string | null;
  purgedAt?: Date | null;
  id: string; workspaceId: string; createdByUserId: string; targetFolderId: string; desiredFileName: string; mimeType: string;
  expectedSizeBytes: number; expectedChecksum: string; targetFileId: string | null;
  status: 'CREATED' | 'UPLOADING' | 'COMPLETING' | 'PROCESSING' | 'COMPLETED' | 'ABORTED' | 'FAILED';
  conflictMode: 'CREATE_VERSION' | 'RENAME' | 'CANCEL' | null; idempotencyKey: string; fingerprint: string; expiresAt: Date;
  parts: Array<{ partNumber: number; sizeBytes: number; checksum: string; objectKey: string }>;
  resultFileId: string | null; resultVersionId: string | null; version: number; createdAt: Date; updatedAt: Date;
  cleanupClaimId: string | null; cleanupLeaseExpiresAt: Date | null; cleanupNextAttemptAt: Date | null;
  cleanupAttempts: number; cleanupErrorCode: string | null; cleanedAt: Date | null;
  processingClaimId: string | null; processingLeaseExpiresAt: Date | null; processingNextAttemptAt: Date | null;
  processingAttempts: number; processingErrorCode: string | null;
};
export type FileObjectGarbage = {
  id: string; workspaceId: string; objectKey: string; createdAt: Date; updatedAt: Date;
  claimId: string | null; leaseExpiresAt: Date | null; nextAttemptAt: Date;
  attempts: number; errorCode: string | null; cleanedAt: Date | null;
};
