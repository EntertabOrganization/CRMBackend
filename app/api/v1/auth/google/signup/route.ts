import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { authRateLimitPolicies, rateLimitRequest } from '@/src/server/rate-limit';
import { readJson } from '@/src/server/request';
import { route } from '@/src/server/response';

export async function POST(request: NextRequest) {
  return route(async () => {
    rateLimitRequest(request, authRateLimitPolicies.googleAuth);
    const body = await readJson<{ credential: string }>(request);
    return appContext.auth.googleAuth(body.credential);
  });
}
