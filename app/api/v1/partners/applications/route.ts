import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { readJson, requireUser } from '@/src/server/request';
import { route } from '@/src/server/response';

export async function POST(request: NextRequest) {
  return route(async () => {
    const user = await requireUser(request, appContext.store);
    return appContext.partners.submitApplication(user, await readJson(request));
  });
}
