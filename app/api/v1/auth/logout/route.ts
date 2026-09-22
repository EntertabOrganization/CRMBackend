import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { authRateLimitPolicies, rateLimitRequest } from '@/src/server/rate-limit';
import { readJson } from '@/src/server/request';
import { route } from '@/src/server/response';

export async function POST(request: NextRequest) {
  return route(async () => {
    rateLimitRequest(request, authRateLimitPolicies.logout);
    const body = await readJson<{ refreshToken: string }>(request);
    return appContext.auth.logout(body.refreshToken);
  });
}
