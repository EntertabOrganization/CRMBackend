import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { AuthDomainService } from './auth-domain.service';
import { currentUserId, normalizeQuery, ok, page, workspaceId } from './http-utils';

@Controller()
export class DepartmentController {
  constructor(private readonly auth: AuthDomainService) {}

  @Post('departments')
  @HttpCode(200)
  create(@Req() req: any, @Body() body: { name: string; parentDepartmentId?: string | null; description?: string | null; managerId?: string | null }) {
    return ok(this.auth.createDepartment(currentUserId(this.auth, req), workspaceId(req), body));
  }

  @Post('departments/:parentId/sub-departments')
  @HttpCode(200)
  createSubDepartment(@Req() req: any, @Param('parentId') parentId: string, @Body() body: { name: string; description?: string | null; managerId?: string | null }) {
    return ok(this.auth.createDepartment(currentUserId(this.auth, req), workspaceId(req), { ...body, parentDepartmentId: parentId }));
  }

  @Get('departments')
  list(@Req() req: any, @Query() query: any) {
    return page(this.auth.listDepartments(currentUserId(this.auth, req), workspaceId(req), normalizeQuery(query)));
  }

  @Get('departments/tree')
  tree(@Req() req: any) {
    const ws = workspaceId(req);
    const departments = this.auth.listDepartments(currentUserId(this.auth, req), ws, { limit: 100 }).data;
    return ok(departments.filter((d) => !d.parentDepartmentId).map((d) => ({ ...d, children: this.auth.descendants(ws, d.id) })));
  }

  @Get('departments/:id')
  get(@Req() req: any, @Param('id') id: string) {
    const ws = workspaceId(req);
    this.auth.authorizeResource(currentUserId(this.auth, req), ws, 'department.read', { workspaceId: ws });
    return ok(this.auth.state.departments.find((d) => d.id === id && d.workspaceId === ws && !d.isDeleted));
  }

  @Get('departments/:id/children')
  children(@Req() req: any, @Param('id') id: string) {
    return ok(this.auth.children(workspaceId(req), id));
  }

  @Get('departments/:id/descendants')
  descendants(@Req() req: any, @Param('id') id: string) {
    return ok(this.auth.descendants(workspaceId(req), id));
  }

  @Get('departments/:id/ancestors')
  ancestors(@Req() req: any, @Param('id') id: string) {
    return ok(this.auth.ancestors(workspaceId(req), id));
  }

  @Patch('departments/:id/move')
  move(@Req() req: any, @Param('id') id: string, @Body() body: { parentDepartmentId: string | null }) {
    return ok(this.auth.moveDepartment(currentUserId(this.auth, req), workspaceId(req), id, body.parentDepartmentId));
  }

  @Put('departments/:id')
  replace(@Req() req: any, @Param('id') id: string, @Body() body: { name: string; description: string | null; parentDepartmentId?: string | null; managerId?: string | null }) {
    return ok(this.auth.updateDepartment(currentUserId(this.auth, req), workspaceId(req), id, body, true));
  }

  @Patch('departments/:id')
  update(@Req() req: any, @Param('id') id: string, @Body() body: { name?: string; description?: string | null; parentDepartmentId?: string | null; managerId?: string | null }) {
    return ok(this.auth.updateDepartment(currentUserId(this.auth, req), workspaceId(req), id, body));
  }

  @Patch('departments/:id/restore')
  restore(@Req() req: any, @Param('id') id: string) {
    this.auth.restoreDepartment(currentUserId(this.auth, req), workspaceId(req), id);
    return ok(null);
  }

  @Delete('departments/:id/hard')
  @HttpCode(200)
  hardDelete(@Req() req: any, @Param('id') id: string) {
    this.auth.hardDeleteDepartment(currentUserId(this.auth, req), workspaceId(req), id);
    return ok(null);
  }

  @Delete('departments/:id')
  @HttpCode(200)
  softDelete(@Req() req: any, @Param('id') id: string) {
    this.auth.softDeleteDepartment(currentUserId(this.auth, req), workspaceId(req), id);
    return ok(null);
  }

  @Get('department-members')
  listMembers(@Req() req: any, @Query() query: any) {
    return page(this.auth.listDepartmentMembers(currentUserId(this.auth, req), workspaceId(req), normalizeQuery(query)));
  }

  @Post('department-members')
  @HttpCode(200)
  bulkAddMembers(@Req() req: any, @Body() body: { departmentId: string; userIds: string[] }) {
    return ok(this.auth.bulkAddDepartmentMembers(currentUserId(this.auth, req), workspaceId(req), body.departmentId, body.userIds));
  }

  @Patch('department-members/:id/restore')
  restoreMember(@Req() req: any, @Param('id') id: string) {
    this.auth.restoreDepartmentMember(currentUserId(this.auth, req), workspaceId(req), id);
    return ok(null);
  }

  @Delete('department-members/:id/hard')
  @HttpCode(200)
  hardDeleteMember(@Req() req: any, @Param('id') id: string) {
    this.auth.hardDeleteDepartmentMember(currentUserId(this.auth, req), workspaceId(req), id);
    return ok(null);
  }

  @Delete('department-members/:departmentId/:userId')
  @HttpCode(200)
  removeMember(@Req() req: any, @Param('departmentId') departmentId: string, @Param('userId') userId: string) {
    this.auth.removeDepartmentMember(currentUserId(this.auth, req), workspaceId(req), departmentId, userId);
    return ok(null);
  }
}
