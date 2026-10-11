import { appContext } from '@/src/server/app-context';
import { collabRouteHandlers } from '@/src/server/collab/http';
const handlers = collabRouteHandlers('notification-preferences', () => appContext.collab.router);
export const GET = handlers.GET;
export const PUT = handlers.PUT;
