import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { readJson } from '@/src/server/request';
import { route } from '@/src/server/response';

type Params = { params: Promise<{ triggerCode: string }> };

/**
 * Inbound custom Trigger invocation for installed applications. The caller authenticates with an integration credential
 * (X-Automation-Integration-Key); the workspace, installation and trigger ownership all come from that credential, never
 * from the request body. The payload is validated against the trigger's typed schema and only becomes read-only context.
 */
export async function POST(request: NextRequest, { params }: Params) {
  return route(async () => {
    const { triggerCode } = await params;
    const body = await readJson<Record<string, unknown>>(request);
    return appContext.automation.extensions.invokeCustomTrigger(request.headers.get('x-automation-integration-key'), triggerCode, body);
  });
}
