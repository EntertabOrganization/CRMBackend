import { nextHandlers } from '@/src/server/platform/http';
import { platformRouter } from '@/src/server/platform/routes';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const { GET, POST, PUT, PATCH } = nextHandlers(platformRouter);
