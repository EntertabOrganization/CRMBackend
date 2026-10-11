import { appContext } from '@/src/server/app-context';
import { collabRouteHandlers } from '@/src/server/collab/http';
const handlers = collabRouteHandlers('entities', () => appContext.collab.router);
export const GET = handlers.GET;
