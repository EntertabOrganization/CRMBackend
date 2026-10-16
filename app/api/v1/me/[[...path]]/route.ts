import { nextHandlers } from '@/src/server/platform/http';
import { meRouter } from '@/src/server/platform/routes';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const { GET, POST, PUT, PATCH, DELETE } = nextHandlers(meRouter);
