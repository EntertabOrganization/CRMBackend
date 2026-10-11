import { appContext } from '@/src/server/app-context';
import { collabRouteHandlers } from '@/src/server/collab/http';
const handlers = collabRouteHandlers('calendar-resources', () => appContext.collab.router);
export const GET = handlers.GET;
export const POST = handlers.POST;
export const PUT = handlers.PUT;
export const PATCH = handlers.PATCH;
export const DELETE = handlers.DELETE;
