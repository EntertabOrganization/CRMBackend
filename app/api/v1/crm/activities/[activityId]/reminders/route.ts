import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { readJson } from '@/src/server/request';
import { route } from '@/src/server/response';
import { requireWorkspaceContext } from '@/src/server/route-helpers';

export async function GET(request: NextRequest, { params }: { params: Promise<{ activityId: string }> }) {
  return route(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request);
    const { activityId } = await params;
    return appContext.activities.listReminders(user, workspaceId, activityId);
  });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ activityId: string }> }) {
  return route(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request);
    const { activityId } = await params;
    return appContext.activities.createReminder(user, workspaceId, activityId, await readJson<Record<string, unknown>>(request));
  });
}
