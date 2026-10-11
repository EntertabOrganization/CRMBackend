import { appContext } from '@/src/server/app-context';
import { collabRouteHandlers } from '@/src/server/collab/http';
const handlers = collabRouteHandlers('public/collab-invitations', () => appContext.collab.router);
export const POST = handlers.POST;
