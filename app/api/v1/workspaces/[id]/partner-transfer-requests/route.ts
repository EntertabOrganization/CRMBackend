import { nextHandlers } from '@/src/server/platform/http';
import { workspacePartnerRouter } from '@/src/server/partners/routes';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const { POST } = nextHandlers(workspacePartnerRouter);
