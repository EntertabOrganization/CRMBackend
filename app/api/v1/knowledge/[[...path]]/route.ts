import { nextHandlers } from '@/src/server/platform/http';
import { knowledgeRouter } from '@/src/server/knowledge/routes';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const { GET, POST, PUT, PATCH, DELETE } = nextHandlers(knowledgeRouter);
