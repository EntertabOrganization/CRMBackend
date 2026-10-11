import { appContext } from '@/src/server/app-context';
import { collabRouteHandlers, listed } from '@/src/server/collab/http';
import { requireUser, workspaceHeader } from '@/src/server/request';
// External guests have no Workspace membership: they read only their own Collab, members and resources, never through a Workspace role.
const handlers = collabRouteHandlers('collabs', () => appContext.collab.router, async (request, rest) => {
  const view = rest.length === 1 ? 'collab' : rest.length === 2 && (rest[1] === 'members' || rest[1] === 'resources') ? rest[1] : null;
  if (!view || request.headers.get('authorization')?.startsWith('Bearer trm_api_')) return null;
  const user = await requireUser(request, appContext.store), workspaceId = workspaceHeader(request);
  if (!workspaceId || appContext.collab.support.isEligibleUser(workspaceId, user.id)) return null;
  if (!appContext.store.state.collabSpaceMembers.some(row => row.workspaceId === workspaceId && row.userId === user.id && row.memberType === 'EXTERNAL')) return null;
  const result = appContext.collab.communication.collabs.guestRead(workspaceId, user.id, rest[0], view as 'collab' | 'members' | 'resources', request.nextUrl.searchParams);
  return { data: view === 'members' ? listed(result as Parameters<typeof listed>[0]) : result };
});
export const GET = handlers.GET;
export const POST = handlers.POST;
export const PUT = handlers.PUT;
export const PATCH = handlers.PATCH;
export const DELETE = handlers.DELETE;
