import { nextHandlers } from '@/src/server/platform/http';
import { partnerPortalRouter } from '@/src/server/partners/routes';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const { GET, POST, PUT, PATCH, DELETE } = nextHandlers(partnerPortalRouter);
