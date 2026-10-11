import { appContext } from '@/src/server/app-context';
import { collabRouteHandlers } from '@/src/server/collab/http';
const handlers = collabRouteHandlers('channel-comments', () => appContext.collab.router);
export const PATCH = handlers.PATCH;
export const DELETE = handlers.DELETE;
