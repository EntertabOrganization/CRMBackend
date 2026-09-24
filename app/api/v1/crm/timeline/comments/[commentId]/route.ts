import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { readJson } from '@/src/server/request';
import { route } from '@/src/server/response';
import { requireWorkspaceContext } from '@/src/server/route-helpers';

export async function GET(request: NextRequest, { params }: { params: Promise<{ commentId: string }> }) {
  return route(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request);
    const { commentId } = await params;
    return appContext.timeline.getComment(user, workspaceId, commentId);
  });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ commentId: string }> }) {
  return route(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request, 'comment');
    const { commentId } = await params;
    return appContext.timeline.updateComment(user, workspaceId, commentId, await readJson<Record<string, unknown>>(request));
  });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ commentId: string }> }) {
  return route(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request, 'comment');
    const { commentId } = await params;
    return appContext.timeline.deleteComment(user, workspaceId, commentId);
  });
}
