import { nextHandlers } from '@/src/server/platform/http';
import { platformPartnerRouter } from '@/src/server/partners/routes';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const { GET, POST, PATCH, DELETE } = nextHandlers(platformPartnerRouter);
