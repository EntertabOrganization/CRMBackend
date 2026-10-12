import { createHash, randomUUID } from 'node:crypto';
import { AccessService } from '../../access-service';
import { hydrateState } from '../../persistence';
import { InMemoryStore } from '../../store';
import { RealtimeHub } from '../../realtime';
import { AppError } from '../../errors';
import { Body } from '../support';
import { CollaborationModule } from '..';
import { UnconfiguredFilePort } from '../../ports';
import { evidence, lock, type Principal, type Tx } from '../../process-platform/context';
import { LocalObjectStorage, assertProcessingResult, type FileContentProcessor, type ObjectStorage } from './object-storage';
import { EnvironmentContentProcessor } from './content-processor';

export type PreparedFileArtifact = { workspaceId: string; objectKey: string; checksum: string; size: number; mimeType: string };
/** Files owns immutable content and metadata publication. Domain export workers never insert Files rows themselves. */
export class FileArtifactService {
  constructor(private readonly objects: ObjectStorage = new LocalObjectStorage(),
    private readonly processor: FileContentProcessor = new EnvironmentContentProcessor()) {}
  async prepare(workspaceId: string, content: Buffer, mimeType: string): Promise<PreparedFileArtifact> {
    if (content.length > 50_000_000) throw new AppError('FILE_TOO_LARGE', 'Artifact exceeds processing limits.', 413);
    const result = await this.processor.process(content, mimeType);
    assertProcessingResult(result);
    if (result.scanStatus !== 'CLEAN' || !result.processed) throw new AppError('FILE_QUARANTINED', 'Artifact processing has not completed.', 409);
    const objectKey = workspaceId + '/artifacts/' + randomUUID();
    await this.objects.putImmutable(objectKey, content);
    return { workspaceId, objectKey, checksum: createHash('sha256').update(content).digest('hex'), size: content.length, mimeType };
  }
  async publish(tx: Tx, principal: Principal, prepared: PreparedFileArtifact, name: string) {
    if (prepared.workspaceId !== principal.workspaceId) throw new AppError('PERMISSION_DENIED', 'Artifact Workspace does not match.', 403);
    await lock(tx, principal.workspaceId, 'files:artifact-publication');
    const store = new InMemoryStore(await hydrateState(tx));
    const access = new AccessService(store);
    const user = store.state.users.find(u => u.id === principal.userId && u.status === 'ACTIVE' && !u.isDeleted);
    if (!user) throw new AppError('PERMISSION_DENIED', 'Active creator is required.', 403);
    const actor = access.actor(user, principal.workspaceId);
    const collab = new CollaborationModule({ store, access, realtime: new RealtimeHub(), files: () => new UnconfiguredFilePort() });
    let storage = store.state.fileStorages.find(s => s.workspaceId === principal.workspaceId && s.type === 'PERSONAL' && s.ownerUserId === principal.userId && s.isActive);
    if (!storage) {
      const before = new Set(store.state.fileStorages.map(s => s.id));
      collab.files.storages.createStorage(actor, new Body({ type: 'PERSONAL', name: 'Personal files', ownerUserId: principal.userId }));
      storage = store.state.fileStorages.find(s => !before.has(s.id) && s.workspaceId === principal.workspaceId);
      if (!storage) throw new AppError('STORAGE_NOT_FOUND', 'Private artifact storage is unavailable.', 409);
      await tx.projectFileStorage.create({ data: storage });
      for (const folder of store.state.fileFolders.filter(f => f.storageId === storage!.id))
        await tx.projectRootFolder.create({ data: { ...folder, publicShareVersion: folder.publicShareVersion ?? 1 } });
    }
    const root = store.state.fileFolders.find(f => f.workspaceId === principal.workspaceId && f.storageId === storage!.id && f.parentFolderId === null && f.status === 'ACTIVE');
    if (!root) throw new AppError('FOLDER_NOT_FOUND', 'Private artifact folder is unavailable.', 409);
    const { file, version } = collab.files.records.publishArtifact(actor, { ...prepared, folderId: root.id, name });
    await tx.driveFile.create({ data: { ...file, currentVersionId: null } });
    await tx.driveFileVersion.create({ data: version });
    await tx.driveFile.update({ where: { id: file.id }, data: { currentVersionId: version.id } });
    await evidence(tx, principal, 'FILE', file.id, 'FILE_CREATED', { folderId: file.folderId, currentVersionId: version.id, status: file.status });
    return file.id;
  }
  async discard(prepared: PreparedFileArtifact) { await this.objects.remove?.(prepared.objectKey); }
}
