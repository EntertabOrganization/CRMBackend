import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { authRateLimitPolicies, rateLimitRequest } from '@/src/server/rate-limit';
import { readJson } from '@/src/server/request';
import { route } from '@/src/server/response';

export async function POST(request: NextRequest) {
  return route(async () => {
    rateLimitRequest(request, authRateLimitPolicies.signup);
    const body = await readJson<Record<string, unknown>>(request);
    const visitorToken = request.cookies.get('site_visitor')?.value;
    const consent = request.cookies.get('site_consent')?.value.split(',').includes('MARKETING');
    return appContext.auth.signup({ ...body, ...(body.referral === undefined && visitorToken && consent ? { referral: { visitorToken, consent: 'ATTRIBUTION' } } : {}) } as Parameters<typeof appContext.auth.signup>[0]);
  });
}
