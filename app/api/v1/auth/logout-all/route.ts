import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { authRateLimitPolicies, rateLimitRequest } from '@/src/server/rate-limit';
import { requireUser } from '@/src/server/request';
import { route } from '@/src/server/response';

export async function POST(request: NextRequest) {
  return route(async () => {
    rateLimitRequest(request, authRateLimitPolicies.logoutAll);
    const user = await requireUser(request, appContext.store);
    return appContext.auth.logoutAll(user.id);
  });
}
