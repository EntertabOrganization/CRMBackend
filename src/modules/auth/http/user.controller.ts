import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { AuthDomainService } from './auth-domain.service';
import { currentUserId, normalizeQuery, ok, page, workspaceId } from './http-utils';

@Controller('users')
export class UserController {
  constructor(private readonly auth: AuthDomainService) {}

  @Get()
  list(@Req() req: any, @Query() query: any) {
    return page(this.auth.listUsers(currentUserId(this.auth, req), workspaceId(req), normalizeQuery(query)));
  }

  @Get(':id')
  get(@Req() req: any, @Param('id') id: string) {
    const requester = currentUserId(this.auth, req);
    if (requester === id) return ok(this.auth.state.users.find((u) => u.id === id));
    this.auth.authorizeResource(requester, workspaceId(req), 'user.read', { workspaceId: workspaceId(req) });
    return ok(this.auth.state.users.find((u) => u.id === id));
  }

  @Post()
  @HttpCode(200)
  invite(@Req() req: any, @Body() body: { email: string; roleId?: string }) {
    return ok(this.auth.inviteUser(currentUserId(this.auth, req), workspaceId(req), body));
  }

  @Post('invitations/accept')
  @HttpCode(200)
  acceptInvitation(@Body() body: { token: string; email: string; firstName?: string; lastName?: string; password?: string }) {
    return ok(this.auth.acceptInvitation(body.token, body));
  }

  @Post('invitations/:id/resend')
  @HttpCode(200)
  resendInvitation(@Req() req: any, @Param('id') id: string) {
    return ok(this.auth.resendInvitation(currentUserId(this.auth, req), workspaceId(req), id));
  }

  @Post('invitations/reject')
  @HttpCode(200)
  rejectInvitation(@Body() body: { token: string; email: string }) {
    this.auth.rejectInvitation(body.token, body.email);
    return ok(null);
  }

  @Delete('invitations/:id')
  @HttpCode(200)
  revokeInvitation(@Req() req: any, @Param('id') id: string) {
    this.auth.revokeInvitation(currentUserId(this.auth, req), workspaceId(req), id);
    return ok(null);
  }

  @Put(':id')
  replace(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    return ok(this.auth.updateUser(currentUserId(this.auth, req), id, body, true));
  }

  @Delete(':id/workspace-membership')
  @HttpCode(200)
  removeFromWorkspace(@Req() req: any, @Param('id') id: string) {
    this.auth.removeWorkspaceMember(currentUserId(this.auth, req), workspaceId(req), id);
    return ok(null);
  }

  @Patch(':id/restore')
  restore(@Req() req: any, @Param('id') id: string) {
    this.auth.restoreUser(currentUserId(this.auth, req), id);
    return ok(null);
  }

  @Patch(':id/suspend')
  suspend(@Req() req: any, @Param('id') id: string) {
    this.auth.suspendUser(currentUserId(this.auth, req), id);
    return ok(null);
  }

  @Patch(':id/reactivate')
  reactivate(@Req() req: any, @Param('id') id: string) {
    this.auth.reactivateUser(currentUserId(this.auth, req), id);
    return ok(null);
  }

  @Patch(':id')
  update(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    return ok(this.auth.updateUser(currentUserId(this.auth, req), id, body));
  }

  @Delete(':id/hard')
  @HttpCode(200)
  hardDelete(@Req() req: any, @Param('id') id: string) {
    this.auth.hardDeleteUser(currentUserId(this.auth, req), id);
    return ok(null);
  }

  @Delete(':id')
  @HttpCode(200)
  softDelete(@Req() req: any, @Param('id') id: string) {
    this.auth.softDeleteUser(currentUserId(this.auth, req), id);
    return ok(null);
  }
}
