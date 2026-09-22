import { appContext } from '@/src/server/app-context';
import { route } from '@/src/server/response';

export async function GET() {
  return route(async () => appContext.roles.permissions());
}
