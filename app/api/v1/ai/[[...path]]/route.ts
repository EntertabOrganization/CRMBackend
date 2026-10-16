import { nextHandlers } from '@/src/server/platform/http';
import { aiRouter } from '@/src/server/ai/routes';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const { GET, POST, PUT, PATCH, DELETE } = nextHandlers(aiRouter);
