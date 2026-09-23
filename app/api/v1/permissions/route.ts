import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { requireUser } from '@/src/server/request';
import { route } from '@/src/server/response';

export async function GET(request: NextRequest) {
  return route(async () => {
    await requireUser(request, appContext.store);
    return appContext.roles.permissions();
  });
}
