import { nextHandlers } from '@/src/server/platform/http';
import { knowledgePublicRouter } from '@/src/server/knowledge/routes';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const { POST } = nextHandlers(knowledgePublicRouter);
