import { nextHandlers } from '@/src/server/platform/http';
import { billingInternalRouter } from '@/src/server/billing/routes';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const { POST } = nextHandlers(billingInternalRouter);
