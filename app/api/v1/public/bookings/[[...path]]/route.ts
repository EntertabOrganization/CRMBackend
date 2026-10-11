import type { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { collabRouteHandlers } from '@/src/server/collab/http';
import { AppError } from '@/src/server/errors';
import { rateLimitRequest } from '@/src/server/rate-limit';
import { fail } from '@/src/server/response';
const handlers = collabRouteHandlers('public/bookings', () => appContext.collab.router);
export async function POST(request: NextRequest, context: Parameters<typeof handlers.POST>[1]) {
  try {
    rateLimitRequest(request, { scope: 'booking.public.capability', limit: 10, windowMs: 60_000 });
    return await handlers.POST(request, context);
  } catch (error) {
    return fail(error instanceof AppError && error.code === 'RATE_LIMITED'
      ? new AppError('BOOKING_RATE_LIMITED', 'Too many booking requests.', 429) : error);
  }
}
