import { nextHandlers } from '@/src/server/platform/http';
import { platformBillingRouter } from '@/src/server/billing/routes';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const { GET, POST } = nextHandlers(platformBillingRouter);
