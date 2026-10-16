import { nextHandlers } from '@/src/server/platform/http';
import { aiInternalRouter } from '@/src/server/ai/routes';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const { POST } = nextHandlers(aiInternalRouter);
