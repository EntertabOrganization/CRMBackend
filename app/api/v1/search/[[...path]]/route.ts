import { nextHandlers } from '@/src/server/platform/http';
import { searchRouter } from '@/src/server/platform/routes';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const { GET, POST } = nextHandlers(searchRouter);
