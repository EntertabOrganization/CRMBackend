import { appContext } from '@/src/server/app-context';
import { collabRouteHandlers } from '@/src/server/collab/http';
const handlers = collabRouteHandlers('polls', () => appContext.collab.router);
export const POST = handlers.POST;
export const DELETE = handlers.DELETE;
