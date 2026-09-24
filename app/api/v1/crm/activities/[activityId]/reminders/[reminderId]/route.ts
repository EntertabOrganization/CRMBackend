import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { readJson } from '@/src/server/request';
import { route } from '@/src/server/response';
import { requireWorkspaceContext } from '@/src/server/route-helpers';

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ activityId: string; reminderId: string }> }) {
  return route(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request);
    const { activityId, reminderId } = await params;
    return appContext.activities.updateReminder(user, workspaceId, activityId, reminderId, await readJson<Record<string, unknown>>(request));
  });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ activityId: string; reminderId: string }> }) {
  return route(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request);
    const { activityId, reminderId } = await params;
    return appContext.activities.deleteReminder(user, workspaceId, activityId, reminderId);
  });
}
