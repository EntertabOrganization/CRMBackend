import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { PermissionScope } from '../auth-module';
import { AuthDomainService } from './auth-domain.service';
import { currentUserId, normalizeQuery, ok, page, workspaceId } from './http-utils';

@Controller()
export class AuthorizationController {
  constructor(private readonly auth: AuthDomainService) {}

  @Get('permissions')
  permissions(@Query() query: any) {
    return page(this.auth.listPermissions(normalizeQuery(query)));
  }

  @Get('permissions/:id')
  permission(@Param('id') id: string) {
    return ok(this.auth.state.permissions.find((p) => p.id === id));
  }

  @Get('roles')
  roles(@Req() req: any, @Query() query: any) {
    return page(this.auth.listRoles(currentUserId(this.auth, req), workspaceId(req), normalizeQuery(query)));
  }

  @Post('roles')
  @HttpCode(200)
  createRole(@Req() req: any, @Body() body: { name: string; description?: string | null; permissions?: Array<{ permissionId: string; scope: PermissionScope }> }) {
    return ok(this.auth.createRole(currentUserId(this.auth, req), workspaceId(req), body));
  }

  @Get('roles/:id')
  role(@Req() req: any, @Param('id') id: string) {
    return ok(this.auth.getRole(currentUserId(this.auth, req), workspaceId(req), id));
  }

  @Put('roles/:id')
  replaceRole(@Req() req: any, @Param('id') id: string, @Body() body: { name: string; description: string | null }) {
    return ok(this.auth.updateRole(currentUserId(this.auth, req), workspaceId(req), id, body, true));
  }

  @Patch('roles/:id')
  updateRole(@Req() req: any, @Param('id') id: string, @Body() body: { name?: string; description?: string | null }) {
    return ok(this.auth.updateRole(currentUserId(this.auth, req), workspaceId(req), id, body));
  }

  @Put('roles/:id/permissions')
  replaceRolePermissions(@Req() req: any, @Param('id') id: string, @Body() body: { permissions: Array<{ permissionId: string; scope: PermissionScope }> }) {
    this.auth.replaceRolePermissions(currentUserId(this.auth, req), workspaceId(req), id, body.permissions);
    return ok(null);
  }

  @Patch('roles/:id/restore')
  restoreRole(@Req() req: any, @Param('id') id: string) {
    this.auth.restoreRole(currentUserId(this.auth, req), workspaceId(req), id);
    return ok(null);
  }

  @Delete('roles/:id/hard')
  @HttpCode(200)
  hardDeleteRole(@Req() req: any, @Param('id') id: string) {
    this.auth.hardDeleteRole(currentUserId(this.auth, req), workspaceId(req), id);
    return ok(null);
  }

  @Delete('roles/:id')
  @HttpCode(200)
  deleteRole(@Req() req: any, @Param('id') id: string) {
    this.auth.deleteRole(currentUserId(this.auth, req), workspaceId(req), id);
    return ok(null);
  }
}
