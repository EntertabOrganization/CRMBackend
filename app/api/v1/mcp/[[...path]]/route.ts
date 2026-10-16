import { nextHandlers } from '@/src/server/platform/http';
import { mcpRouter } from '@/src/server/ai/routes';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const { GET, POST } = nextHandlers(mcpRouter);
