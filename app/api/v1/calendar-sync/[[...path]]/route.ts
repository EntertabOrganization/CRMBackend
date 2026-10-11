import { appContext } from '@/src/server/app-context';
import { collabRouteHandlers } from '@/src/server/collab/http';
const handlers = collabRouteHandlers('calendar-sync', () => appContext.collab.router);
export const GET = handlers.GET;
export const POST = handlers.POST;
export const DELETE = handlers.DELETE;
