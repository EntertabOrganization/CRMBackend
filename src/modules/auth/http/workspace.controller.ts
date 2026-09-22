import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { AuthDomainService } from './auth-domain.service';
import { currentUserId, normalizeQuery, ok, page } from './http-utils';

@Controller('workspaces')
export class WorkspaceController {
  constructor(private readonly auth: AuthDomainService) {}

  @Post()
  @HttpCode(200)
  create(@Req() req: any, @Body() body: { name: string; description?: string | null }) {
    return ok(this.auth.createWorkspace(currentUserId(this.auth, req), body));
  }

  @Get()
  list(@Req() req: any, @Query() query: any) {
    return page(this.auth.listWorkspaces(currentUserId(this.auth, req), normalizeQuery(query)));
  }

  @Get(':id')
  get(@Req() req: any, @Param('id') id: string) {
    return ok(this.auth.getWorkspace(currentUserId(this.auth, req), id));
  }

  @Put(':id')
  replace(@Req() req: any, @Param('id') id: string, @Body() body: { name: string; description: string | null }) {
    return ok(this.auth.updateWorkspace(currentUserId(this.auth, req), id, body, true));
  }

  @Patch(':id')
  update(@Req() req: any, @Param('id') id: string, @Body() body: { name: string; description: string | null }) {
    return ok(this.auth.updateWorkspace(currentUserId(this.auth, req), id, body));
  }

  @Delete(':id')
  @HttpCode(200)
  softDelete(@Req() req: any, @Param('id') id: string) {
    this.auth.softDeleteWorkspace(currentUserId(this.auth, req), id);
    return ok(null);
  }

  @Patch(':id/restore')
  restore(@Req() req: any, @Param('id') id: string) {
    this.auth.restoreWorkspace(currentUserId(this.auth, req), id);
    return ok(null);
  }

  @Delete(':id/hard')
  @HttpCode(200)
  hardDelete(@Req() req: any, @Param('id') id: string) {
    this.auth.hardDeleteWorkspace(currentUserId(this.auth, req), id);
    return ok(null);
  }

  @Post(':id/switch')
  @HttpCode(200)
  switch(@Req() req: any, @Param('id') id: string) {
    return ok(this.auth.switchWorkspace(currentUserId(this.auth, req), id));
  }

  @Post(':id/transfer-owner')
  @HttpCode(200)
  transferOwner(@Req() req: any, @Param('id') id: string, @Body() body: { targetUserId: string }) {
    this.auth.transferWorkspaceOwner(currentUserId(this.auth, req), id, body.targetUserId);
    return ok(null);
  }

  @Patch(':id/members/:userId/suspend')
  suspendMember(@Req() req: any, @Param('id') id: string, @Param('userId') userId: string) {
    this.auth.suspendWorkspaceMember(currentUserId(this.auth, req), id, userId);
    return ok(null);
  }

  @Patch(':id/members/:userId/reactivate')
  reactivateMember(@Req() req: any, @Param('id') id: string, @Param('userId') userId: string) {
    this.auth.reactivateWorkspaceMember(currentUserId(this.auth, req), id, userId);
    return ok(null);
  }
}
