import { nextHandlers } from '@/src/server/platform/http';
import { platformAiRouter } from '@/src/server/ai/routes';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const { GET, POST } = nextHandlers(platformAiRouter);
