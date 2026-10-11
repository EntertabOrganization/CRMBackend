import type { AccessService, ActorContext } from '../access-service';
import type { FilePort, NotificationPort } from '../ports';
import type { RealtimeHub } from '../realtime';
import type { InMemoryStore } from '../store';
import { CollabRouter } from './http';
import { CollabSupport } from './support';
import { TasksProjectsModule } from './tasks';
import { tasksProjectsRoutes } from './tasks/routes';
import { CalendarModule } from './calendar';
import { calendarRoutes } from './calendar/routes';
import { ChatService } from './communication/chat-service';
import { MessageService } from './communication/message-service';
import { ChannelService } from './communication/channel-service';
import { CollabService } from './communication/collab-service';
import { CallService } from './communication/call-service';
import { FeedService } from './communication/feed-service';
import { calendarSyncRoutes } from './calendar/sync-http';
import { callRoutes } from './communication/call-http';
import { requireUser } from '../request';
import { ProjectDriveService } from './files/project-drive-service';
import { FolderService } from './files/folder-service';
import { FileAccessService } from './files/file-access-service';
import { PublicLinkService } from './files/public-link-service';
import { FileService } from './files/file-service';
import { UploadService } from './files/upload-service';
import { UploadCleanup } from './files/upload-cleanup';
import { UploadProcessing } from './files/upload-processing';
import { ObjectGarbage } from './files/object-garbage';
import { FileDeliveryService } from './files/delivery-service';
import { AttachmentService } from './files/attachment-service';
import { FileLockService } from './files/lock-service';
import { DocumentEditingService } from './files/editing-service';
import { editingRoutes } from './files/editing-http';
import { EditingCleanup } from './files/editing-cleanup';
import { DocumentTemplateService } from './files/document-template-service';
import { GeneratedDocumentService } from './files/generated-document-service';
import { AppError } from '../errors';
import { listed, WithStatus } from './http';

export type CollaborationDeps = {
  store: InMemoryStore;
  access: AccessService;
  realtime: RealtimeHub;
  files: () => FilePort;
  notifications?: () => NotificationPort | null;
};

/**
 * TrueCRM collaboration modules (Tasks & Projects, Calendar & Meetings, Files/Drive/Documents, Communication) behind one
 * router. Each bounded context talks to the others only through the ports it exposes.
 */
export class CollaborationModule {
  readonly support: CollabSupport;
  readonly tasks: TasksProjectsModule;
  readonly calendar: CalendarModule;
  readonly communication: { chats: ChatService; messages: MessageService; channels: ChannelService; collabs: CollabService; calls: CallService; feed: FeedService };
  readonly files: { storages: ProjectDriveService; folders: FolderService; access: FileAccessService; publicLinks: PublicLinkService; records: FileService; uploads: UploadService; uploadCleanup: UploadCleanup; uploadProcessing: UploadProcessing; objectGarbage: ObjectGarbage; delivery: FileDeliveryService };
  readonly attachments: AttachmentService;
  readonly locks: FileLockService;
  readonly editing: DocumentEditingService;
  readonly editingCleanup: EditingCleanup;
  readonly documents: { templates: DocumentTemplateService; generated: GeneratedDocumentService };
  readonly router: CollabRouter;

  constructor(deps: CollaborationDeps) {
    this.support = new CollabSupport(deps);
    this.tasks = new TasksProjectsModule(this.support, deps.files);
    this.calendar = new CalendarModule(this.support, this.tasks, deps.files, deps.notifications);
    const chatService = new ChatService(this.support, this.tasks.policy);
    this.communication = { chats: chatService, messages: new MessageService(this.support, chatService, (workspaceId, actor, fileId) => this.attachments.check(workspaceId, actor, fileId), () => ({
      createTask: (actor, body, key) => this.tasks.tasks.createFromRequest(actor, body, key),
      createEvent: (actor, body, key) => this.calendar.events.create(actor, body, key) as { id: string },
    })), channels: new ChannelService(this.support, this.tasks.policy), collabs: new CollabService(this.support, chatService) } as CollaborationModule['communication'];
    this.communication.feed = new FeedService(this.support, this.tasks.policy);
    this.communication.calls = new CallService(this.support, chatService, this.communication.collabs, {
      check: (workspaceId, actor, fileId) => this.attachments.check(workspaceId, actor, fileId),
      issue: (actor, fileId, query) => this.files.delivery.issue(actor, fileId, query) });
    this.tasks.tasks.setTaskChatPort(this.communication.chats);
    this.tasks.projects.registerProvisioner(this.communication.chats.projectProvisioner());
    const storageService = new ProjectDriveService(this.support, this.tasks.policy, (actor, projectId) => {
      this.tasks.projects.enableTool(actor, projectId, 'DRIVE', true);
      const id = this.tasks.projects.linkedResources(actor, projectId).DRIVE.resourceId;
      return this.support.state.fileStorages.find(row => row.id === id && row.workspaceId === actor.workspaceId)!;
    });
    this.attachments = new AttachmentService(this.support, storageService);
    this.attachments.register({ entityType: 'TASK', exists: (workspaceId, id) => this.support.state.tasks.some(row => row.workspaceId === workspaceId && row.id === id && !row.isDeleted), authorize: (actor, id, write) => {
      const task = this.tasks.policy.task(actor, id);
      if (write) { this.tasks.policy.requireTaskAction(actor, task, 'task.update'); this.tasks.policy.assertTaskWritable(task); }
    } });
    this.attachments.register({ entityType: 'TASK_TEMPLATE', exists: (workspaceId, id) => this.support.state.taskTemplates.some(row => row.workspaceId === workspaceId && row.id === id && !row.isDeleted), authorize: (actor, id, write) => this.tasks.templates.authorizeAttachment(actor, id, write) });
    this.attachments.register({ entityType: 'PROJECT', exists: (workspaceId, id) => this.support.state.projects.some(row => row.workspaceId === workspaceId && row.id === id && !row.isDeleted), authorize: (actor, id, write) => {
      const project = this.tasks.policy.project(actor, id);
      if (write) { this.tasks.policy.requireManageProject(actor, project, 'project.update'); this.tasks.policy.assertNotArchived(project); }
    } });
    this.attachments.register({ entityType: 'CALENDAR_EVENT', exists: (workspaceId, id) => this.support.state.calendarEvents.some(row => row.workspaceId === workspaceId && row.id === id && !row.isDeleted), authorize: (actor, id, write) => {
      const event = this.calendar.events.eventOf(actor, id);
      if (write) this.calendar.events.assertResourceManage(actor, event);
    } });
    this.attachments.register({ entityType: 'CHAT', exists: (workspaceId, id) => this.support.state.chats.some(row => row.workspaceId === workspaceId && row.id === id), authorize: (actor, id, write) => this.communication.chats.authorizeAttachment(actor, id, write) });
    this.attachments.registerLegacyTargets((workspaceId, fileId) => [
      ...this.support.state.taskResults.filter(row => row.workspaceId === workspaceId && row.fileId === fileId).map(row => ({ entityType: 'TASK', entityId: row.taskId })),
      ...this.support.state.taskTemplates.filter(row => row.workspaceId === workspaceId && row.fileIds.includes(fileId)).map(row => ({ entityType: 'TASK_TEMPLATE', entityId: row.id })),
      ...this.support.state.calendarEventFiles.filter(row => row.workspaceId === workspaceId && row.fileId === fileId).map(row => ({ entityType: 'CALENDAR_EVENT', entityId: row.eventId })),
    ]);
    const bindingAuthority = (actor: ActorContext, id: string) => {
      try {
        this.attachments.authorizeBindings(actor, id);
      } catch { throw new AppError('ATTACHMENT_ENTITY_ACCESS_DENIED', 'The owning business record is inaccessible.', 403); }
    };
    this.locks = new FileLockService(this.support, storageService, bindingAuthority);
    const fileService = new FileService(this.support, storageService, bindingAuthority, (workspaceId, ids, allowedLockId) => this.locks.assertUnlocked(workspaceId, ids, allowedLockId));
    const uploadService = new UploadService(this.support, storageService, fileService);
    this.editing = new DocumentEditingService(this.support, storageService, this.locks, uploadService, bindingAuthority);
    this.editingCleanup = new EditingCleanup(this.support, this.editing);
    this.locks.onSessionClosed(row => this.editing.scheduleCleanup(row));
    const linkService = new PublicLinkService(this.support, storageService, (workspaceId, id) => this.attachments.hasPrivateBindings(workspaceId, id));
    const delivery = new FileDeliveryService(this.support, storageService, () => uploadService.objectStorage(), bindingAuthority, linkService);
    this.files = { storages: storageService, folders: new FolderService(this.support, storageService, fileService), access: new FileAccessService(this.support, storageService), publicLinks: linkService, records: fileService, uploads: uploadService, uploadCleanup: new UploadCleanup(this.support, () => uploadService.objectStorage()), uploadProcessing: new UploadProcessing(this.support, uploadService), objectGarbage: new ObjectGarbage(this.support, () => uploadService.objectStorage()), delivery };
    this.tasks.projects.registerProvisioner(this.files.storages.projectProvisioner());
    const templates = new DocumentTemplateService(this.support, storageService, uploadService, bindingAuthority);
    this.documents = { templates, generated: new GeneratedDocumentService(this.support, storageService, templates, fileService, uploadService, delivery) };
    templates.registerContext({ entityType: 'TASK', fields: ['id', 'title', 'description', 'status', 'priority', 'startAt', 'deadlineAt', 'progressPercent', 'responsibleUserId', 'projectId'],
      read: (actor, id) => {
        const task = this.tasks.policy.task(actor, id);
        return { fields: { id: task.id, title: task.title, description: task.description, status: task.status, priority: task.priority, startAt: task.startAt,
          deadlineAt: task.deadlineAt, progressPercent: task.progressPercent, responsibleUserId: task.responsibleUserId, projectId: task.projectId } };
      } });
    templates.registerContext({ entityType: 'PROJECT', fields: ['id', 'name', 'code', 'description', 'status', 'projectType', 'startDate', 'endDate', 'ownerUserId'],
      read: (actor, id) => {
        const project = this.tasks.policy.project(actor, id);
        return { fields: { id: project.id, name: project.name, code: project.code, description: project.description, status: project.status, projectType: project.projectType,
          startDate: project.startDate, endDate: project.endDate, ownerUserId: project.ownerUserId } };
      } });
    this.router = new CollabRouter();
    editingRoutes(this.router, () => this.editing);
    callRoutes(this.router, () => this.communication.calls);
    calendarSyncRoutes(this.router, () => this.calendar.sync);
    tasksProjectsRoutes(this.router, () => this.tasks);
    calendarRoutes(this.router, () => this.calendar);
    const chats = this.communication.chats;
    const storages = this.files.storages;
    const folders = this.files.folders;
    const access = this.files.access;
    const publicLinks = this.files.publicLinks;
    const files = this.files.records;
    const uploads = this.files.uploads;
    this.router.post('files/:id/locks', r => this.locks.acquire(r.actor, r.params.id, r.body))
      .delete('files/:id/locks/:lockId', r => this.locks.release(r.actor, r.params.id, r.params.lockId, r.body))
      .post('files/:id/locks/:lockId/force-release', r => this.locks.forceRelease(r.actor, r.params.id, r.params.lockId, r.body));
    const generated = this.documents.generated;
    this.router.get('document-templates', r => listed(templates.list(r.actor, r.query)))
      .post('document-templates', r => templates.create(r.actor, r.body))
      .get('document-templates/:id', r => templates.get(r.actor, r.params.id))
      .put('document-templates/:id', r => templates.replace(r.actor, r.params.id, r.body, r.ifMatch))
      .patch('document-templates/:id', r => templates.patch(r.actor, r.params.id, r.body, r.ifMatch))
      .delete('document-templates/:id', r => templates.delete(r.actor, r.params.id, r.body, r.ifMatch))
      .post('document-templates/:id/preview', r => templates.preview(r.actor, r.params.id, r.body));
    this.router.get('generated-documents', r => listed(generated.list(r.actor, r.query)))
      .post('generated-documents', r => new WithStatus(202, generated.create(r.actor, r.body)))
      .get('generated-documents/:id', r => generated.get(r.actor, r.params.id))
      .get('generated-documents/:id/download', r => generated.download(r.actor, r.params.id, r.query))
      .post('generated-documents/:id/regenerate', r => new WithStatus(202, generated.regenerate(r.actor, r.params.id, r.body)))
      .delete('generated-documents/:id', r => generated.remove(r.actor, r.params.id, r.body, r.ifMatch));
    this.router.get('attachments', r => listed(this.attachments.list(r.actor, r.query)))
      .post('attachments', r => this.attachments.attach(r.actor, r.body))
      .get('attachments/:id', r => this.attachments.get(r.actor, r.params.id))
      .delete('attachments/:id', r => this.attachments.detach(r.actor, r.params.id, r.body))
      .get('entities/:entityType/:entityId/attachments', r => listed(this.attachments.list(r.actor, r.query, r.params.entityType, r.params.entityId)));
    this.router.post('upload-sessions', r => uploads.create(r.actor, r.body, r.idempotencyKey))
      .get('upload-sessions/:id', r => uploads.get(r.actor, r.params.id))
      .post('upload-sessions/:id/parts', r => uploads.part(r.actor, r.params.id, r.body))
      .post('upload-sessions/:id/complete', r => uploads.complete(r.actor, r.params.id, r.body))
      .post('upload-sessions/:id/abort', r => uploads.abort(r.actor, r.params.id, r.body))
      .post('files/:id/versions', r => uploads.createVersion(r.actor, r.params.id, r.body, r.idempotencyKey));
    this.router.get('files', r => listed(files.list(r.actor, r.query)))
      .get('files/:id/download', r => delivery.issue(r.actor, r.params.id, r.query))
      .get('files/:id', r => files.get(r.actor, r.params.id))
      .patch('files/:id', r => files.update(r.actor, r.params.id, r.body, r.ifMatch))
      .patch('files/:id/move', r => files.move(r.actor, r.params.id, r.body, r.ifMatch))
      .post('files/:id/copy', r => files.copy(r.actor, r.params.id, r.body))
      .delete('files/:id', r => files.trash(r.actor, r.params.id, r.body, r.ifMatch))
      .delete('files/:id/hard', r => files.purge(r.actor, r.params.id, r.body, r.ifMatch))
      .patch('files/:id/restore', r => files.restore(r.actor, r.params.id, r.body, r.ifMatch))
      .get('files/:id/versions', r => listed(files.versions(r.actor, r.params.id, r.query)))
      .get('files/:id/versions/:versionId', r => files.version(r.actor, r.params.id, r.params.versionId))
      .post('files/:id/versions/:versionId/restore', r => files.restoreVersion(r.actor, r.params.id, r.params.versionId, r.body, r.ifMatch))
      .get('files/:id/processing-status', r => files.processing(r.actor, r.params.id))
      .get('files/:id/permissions', r => access.get(r.actor, 'FILE', r.params.id))
      .put('files/:id/permissions', r => access.replace(r.actor, 'FILE', r.params.id, r.body, r.ifMatch));
    this.router.post('folders/:id/public-links', r => publicLinks.createFolder(r.actor, r.params.id, r.body))
      .post('files/:id/public-links', r => publicLinks.createFile(r.actor, r.params.id, r.body))
      .get('public-links', r => listed(publicLinks.list(r.actor, r.query)))
      .get('public-links/:id', r => publicLinks.get(r.actor, r.params.id))
      .patch('public-links/:id', r => publicLinks.update(r.actor, r.params.id, r.body, r.ifMatch))
      .delete('public-links/:id', r => publicLinks.revoke(r.actor, r.params.id, r.body, r.ifMatch))
      .publicRoute('GET', 'public/folders/:token', r => publicLinks.publicFolder(r.params.token, r.query, r.request.headers.get('x-share-password'), r.clientKey))
      .publicRoute('GET', 'public/files/:token', r => publicLinks.publicFile(r.params.token, r.query, r.request.headers.get('x-share-password'), r.clientKey));
    this.router.publicRoute('GET', 'public/files/:token/download', r => delivery.issuePublic(r.params.token, 'FILE', r.query, r.request.headers.get('x-share-password'), r.clientKey))
      .publicRoute('GET', 'public/folders/:token/download', r => delivery.issuePublic(r.params.token, 'FOLDER', r.query, r.request.headers.get('x-share-password'), r.clientKey));
    this.router.get('file-storages/:id/permissions', r => access.get(r.actor, 'STORAGE', r.params.id))
      .put('file-storages/:id/permissions', r => access.replace(r.actor, 'STORAGE', r.params.id, r.body, r.ifMatch))
      .get('folders/:id/permissions', r => access.get(r.actor, 'FOLDER', r.params.id))
      .put('folders/:id/permissions', r => access.replace(r.actor, 'FOLDER', r.params.id, r.body, r.ifMatch));
    this.router.get('file-storages', (r) => listed(storages.list(r.actor, r.query)))
      .post('file-storages', (r) => storages.createStorage(r.actor, r.body))
      .get('file-storages/:id', (r) => storages.get(r.actor, r.params.id))
      .get('file-storages/:id/root', (r) => storages.root(r.actor, r.params.id))
      .patch('file-storages/:id', (r) => storages.updateStorage(r.actor, r.params.id, r.body, r.ifMatch))
      .get('folders/:id', (r) => storages.folder(r.actor, r.params.id))
      .post('folders', (r) => storages.createFolder(r.actor, r.body))
      .get('folders/:id/children', (r) => listed(folders.children(r.actor, r.params.id, r.query)))
      .get('folders/:id/tree', (r) => folders.tree(r.actor, r.params.id, r.query))
      .patch('folders/:id', (r) => folders.update(r.actor, r.params.id, r.body, r.ifMatch))
      .patch('folders/:id/move', (r) => folders.move(r.actor, r.params.id, r.body, r.ifMatch))
      .post('folders/:id/copy', (r) => folders.copy(r.actor, r.params.id, r.body))
      .delete('folders/:id', (r) => folders.trash(r.actor, r.params.id, r.body, r.ifMatch))
      .patch('folders/:id/restore', (r) => folders.restore(r.actor, r.params.id, r.body, r.ifMatch))
      .delete('folders/:id/hard', (r) => folders.purge(r.actor, r.params.id, r.body, r.ifMatch));
    const messages = this.communication.messages;
    this.router.get('chats', r => listed(chats.list(r.actor, r.query)))
      .put('chats/:id', r => chats.update(r.actor, r.params.id, r.body, r.ifMatch, true))
      .patch('chats/:id', r => chats.update(r.actor, r.params.id, r.body, r.ifMatch, false))
      .post('chats/:id/archive', r => chats.archive(r.actor, r.params.id, r.body, r.ifMatch))
      .post('chats/:id/leave', r => chats.leave(r.actor, r.params.id, r.body))
      .get('chats/:id/messages', r => listed(messages.list(r.actor, r.params.id, r.query)))
      .post('chats/:id/messages', r => messages.send(r.actor, r.params.id, r.body))
      .post('chats/:id/read', r => messages.readChat(r.actor, r.params.id, r.body))
      .get('chats/:id/draft', r => messages.getDraft(r.actor, r.params.id))
      .put('chats/:id/draft', r => messages.saveDraft(r.actor, r.params.id, r.body, r.ifMatch))
      .delete('chats/:id/draft', r => messages.deleteDraft(r.actor, r.params.id, r.body));
    const channels = this.communication.channels;
    this.router.post('channels', r => channels.create(r.actor, r.body))
      .get('channels', r => listed(channels.list(r.actor, r.query)))
      .get('channels/:id', r => channels.get(r.actor, r.params.id))
      .put('channels/:id', r => channels.update(r.actor, r.params.id, r.body, r.ifMatch, true))
      .patch('channels/:id', r => channels.update(r.actor, r.params.id, r.body, r.ifMatch, false))
      .delete('channels/:id', r => channels.delete(r.actor, r.params.id, r.body, r.ifMatch))
      .post('channels/:id/archive', r => channels.archive(r.actor, r.params.id, r.body, r.ifMatch))
      .get('channels/:id/members', r => listed(channels.members(r.actor, r.params.id, r.query)))
      .post('channels/:id/members', r => channels.addMember(r.actor, r.params.id, r.body))
      .patch('channels/:id/members/:userId', r => channels.updateMember(r.actor, r.params.id, r.params.userId, r.body))
      .delete('channels/:id/members/:userId', r => channels.removeMember(r.actor, r.params.id, r.params.userId, r.body))
      .post('channels/:id/subscribe', r => channels.subscribe(r.actor, r.params.id, r.body))
      .post('channels/:id/unsubscribe', r => channels.unsubscribe(r.actor, r.params.id, r.body))
      .get('channels/:id/posts', r => listed(channels.posts(r.actor, r.params.id, r.query)))
      .post('channels/:id/posts', r => channels.publish(r.actor, r.params.id, r.body, r.idempotencyKey))
      .get('channel-posts/:id', r => channels.getPost(r.actor, r.params.id))
      .patch('channel-posts/:id', r => channels.editPost(r.actor, r.params.id, r.body, r.ifMatch))
      .delete('channel-posts/:id', r => channels.deletePost(r.actor, r.params.id, r.body, r.ifMatch))
      .get('channel-posts/:id/comments', r => listed(channels.comments(r.actor, r.params.id, r.query)))
      .post('channel-posts/:id/comments', r => channels.comment(r.actor, r.params.id, r.body))
      .patch('channel-comments/:id', r => channels.editComment(r.actor, r.params.id, r.body, r.ifMatch))
      .delete('channel-comments/:id', r => channels.deleteComment(r.actor, r.params.id, r.body, r.ifMatch));
    const collabs = this.communication.collabs;
    this.router.post('collabs', r => collabs.create(r.actor, r.body))
      .get('collabs', r => listed(collabs.list(r.actor, r.query)))
      .get('collabs/:id', r => collabs.get(r.actor, r.params.id))
      .put('collabs/:id', r => collabs.update(r.actor, r.params.id, r.body, r.ifMatch, true))
      .patch('collabs/:id', r => collabs.update(r.actor, r.params.id, r.body, r.ifMatch, false))
      .post('collabs/:id/archive', r => collabs.setArchived(r.actor, r.params.id, r.body, true, r.ifMatch))
      .post('collabs/:id/restore', r => collabs.setArchived(r.actor, r.params.id, r.body, false, r.ifMatch))
      .get('collabs/:id/members', r => listed(collabs.members(r.actor, r.params.id, r.query)))
      .post('collabs/:id/members', r => collabs.addMember(r.actor, r.params.id, r.body))
      .delete('collabs/:id/members/:userId', r => collabs.removeMember(r.actor, r.params.id, r.params.userId, r.body))
      .post('collabs/:id/invitations', r => collabs.invite(r.actor, r.params.id, r.body))
      .post('collabs/:id/invitations/:invitationId/resend', r => collabs.resend(r.actor, r.params.id, r.params.invitationId, r.body))
      .delete('collabs/:id/invitations/:invitationId', r => collabs.revoke(r.actor, r.params.id, r.params.invitationId, r.body))
      .get('collabs/:id/resources', r => collabs.resources(r.actor, r.params.id))
      .publicRoute('POST', 'public/collab-invitations/:token/accept', async r => collabs.accept(await requireUser(r.request, this.support.store), r.params.token, r.body));
    const feed = this.communication.feed;
    this.router.post('feed/posts', r => feed.create(r.actor, r.body, r.idempotencyKey))
      .get('feed', r => listed(feed.list(r.actor, r.query)))
      .get('feed/posts/:id', r => feed.get(r.actor, r.params.id))
      .put('feed/posts/:id', r => feed.update(r.actor, r.params.id, r.body, r.ifMatch, true))
      .patch('feed/posts/:id', r => feed.update(r.actor, r.params.id, r.body, r.ifMatch, false))
      .delete('feed/posts/:id', r => feed.remove(r.actor, r.params.id, r.body, r.ifMatch))
      .patch('feed/posts/:id/restore', r => feed.restore(r.actor, r.params.id, r.body, r.ifMatch))
      .delete('feed/posts/:id/hard', r => feed.hardDelete(r.actor, r.params.id, r.body))
      .post('feed/posts/:id/publish', r => feed.publish(r.actor, r.params.id, r.body))
      .get('feed/posts/:id/comments', r => listed(feed.comments(r.actor, r.params.id, r.query)))
      .post('feed/posts/:id/comments', r => feed.comment(r.actor, r.params.id, r.body))
      .patch('feed/comments/:id', r => feed.editComment(r.actor, r.params.id, r.body, r.ifMatch))
      .delete('feed/comments/:id', r => feed.deleteComment(r.actor, r.params.id, r.body))
      .post('feed/posts/:id/reactions', r => feed.react(r.actor, r.params.id, r.body))
      .delete('feed/posts/:id/reactions/:reaction', r => feed.unreact(r.actor, r.params.id, r.params.reaction, r.body))
      .post('feed/posts/:id/favorite', r => feed.favorite(r.actor, r.params.id, r.body, true))
      .delete('feed/posts/:id/favorite', r => feed.favorite(r.actor, r.params.id, r.body, false))
      .post('feed/posts/:id/pin', r => feed.pin(r.actor, r.params.id, r.body, true))
      .delete('feed/posts/:id/pin', r => feed.pin(r.actor, r.params.id, r.body, false))
      .post('feed/posts/:id/read', r => feed.read(r.actor, r.params.id, r.body))
      .post('feed/posts/:id/acknowledge', r => feed.acknowledge(r.actor, r.params.id, r.body))
      .get('feed/posts/:id/read-stats', r => feed.readStats(r.actor, r.params.id))
      .post('feed/posts/:id/polls', r => feed.createPoll(r.actor, r.params.id, r.body))
      .post('polls/:pollId/votes', r => feed.vote(r.actor, r.params.pollId, r.body))
      .delete('polls/:pollId/votes/me', r => feed.retract(r.actor, r.params.pollId, r.body));
    this.router.get('messages/search', r => listed(messages.search(r.actor, r.query)))
      .get('messages/:id', r => messages.get(r.actor, r.params.id))
      .patch('messages/:id', r => messages.edit(r.actor, r.params.id, r.body, r.ifMatch))
      .delete('messages/:id', r => messages.remove(r.actor, r.params.id, r.body, r.ifMatch))
      .get('messages/:id/versions', r => messages.versions(r.actor, r.params.id))
      .post('messages/:id/reactions', r => messages.react(r.actor, r.params.id, r.body))
      .delete('messages/:id/reactions/:reaction', r => messages.unreact(r.actor, r.params.id, r.params.reaction, r.body))
      .post('messages/:id/pin', r => messages.pin(r.actor, r.params.id, r.body, true))
      .delete('messages/:id/pin', r => messages.pin(r.actor, r.params.id, r.body, false))
      .post('messages/:id/favorite', r => messages.favorite(r.actor, r.params.id, r.body, true))
      .delete('messages/:id/favorite', r => messages.favorite(r.actor, r.params.id, r.body, false))
      .post('messages/:id/read', r => messages.readMessage(r.actor, r.params.id, r.body))
      .post('messages/:id/create-task', r => messages.createFrom(r.actor, r.params.id, 'TASK', r.body, r.idempotencyKey))
      .post('messages/:id/create-event', r => messages.createFrom(r.actor, r.params.id, 'CALENDAR_EVENT', r.body, r.idempotencyKey));
    this.router.get('chats/:id', (r) => chats.get(r.actor, r.params.id))
      .post('chats', (r) => chats.createGroup(r.actor, r.body))
      .post('chats/direct', (r) => chats.direct(r.actor, r.body))
      .get('chats/:id/members', (r) => chats.members(r.actor, r.params.id))
      .post('chats/:id/members', (r) => chats.addMember(r.actor, r.params.id, r.body))
      .delete('chats/:id/members/:userId', (r) => { r.body.only([]); return chats.removeMember(r.actor, r.params.id, r.params.userId); });
  }
}
