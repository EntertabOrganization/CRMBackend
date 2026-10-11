import { appContext } from '@/src/server/app-context';
import { collabRouteHandlers } from '@/src/server/collab/http';
import { requireUser, workspaceHeader } from '@/src/server/request';
const handlers = collabRouteHandlers('chats', () => appContext.collab.router, async (request, rest) => {
  if (!(rest.length === 1 || rest.length === 2 && rest[1] === 'members') || request.headers.get('authorization')?.startsWith('Bearer trm_api_')) return null;
  const user = await requireUser(request, appContext.store), workspaceId = workspaceHeader(request);
  if (!workspaceId || appContext.collab.support.isEligibleUser(workspaceId, user.id)) return null;
  const externalMember = appContext.store.state.collabSpaceMembers.some(row => row.workspaceId === workspaceId && row.userId === user.id &&
    row.memberType === 'EXTERNAL');
  if (!externalMember) return null;
  return { data: appContext.collab.communication.chats.guestRead(workspaceId, user.id, rest[0], rest.length === 2) };
});
export const GET = handlers.GET;
export const POST = handlers.POST;
export const PUT = handlers.PUT;
export const PATCH = handlers.PATCH;
export const DELETE = handlers.DELETE;
