import { workflowRouter } from '../../../../../src/server/workflows/routes';
import type { NextRequest } from 'next/server';
export const runtime = 'nodejs';
export const GET = (request: NextRequest) => workflowRouter.dispatch(request);
export const POST = GET;
