import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { AuthDomainService } from './auth-domain.service';
import { currentUserId, normalizeQuery, ok, page } from './http-utils';

@Controller('partners')
export class PartnerController {
  constructor(private readonly auth: AuthDomainService) {}

  @Post('applications')
  @HttpCode(200)
  submitApplication(@Body() body: any) {
    return ok(this.auth.submitPartnerApplication(body));
  }

  @Get('applications')
  applications(@Req() req: any, @Query() query: any) {
    return page(this.auth.listPartnerApplications(currentUserId(this.auth, req), normalizeQuery(query)));
  }

  @Post('applications/:id/approve')
  @HttpCode(200)
  approve(@Req() req: any, @Param('id') id: string) {
    return ok(this.auth.approvePartnerApplication(currentUserId(this.auth, req), id));
  }

  @Post('applications/:id/reject')
  @HttpCode(200)
  reject(@Req() req: any, @Param('id') id: string) {
    this.auth.rejectPartnerApplication(currentUserId(this.auth, req), id);
    return ok(null);
  }

  @Patch(':id/discounts')
  updateDiscount(@Req() req: any, @Param('id') id: string, @Body() body: { defaultDiscount: number; overrides: Record<string, number> }) {
    return ok(this.auth.updatePartnerDiscount(currentUserId(this.auth, req), id, body.defaultDiscount, body.overrides ?? {}));
  }

  @Put(':id')
  replace(@Req() req: any, @Param('id') id: string, @Body() body: { name: string; country: string; website?: string | null; businessDescription?: string | null }) {
    return ok(this.auth.updatePartner(currentUserId(this.auth, req), id, body, true));
  }

  @Patch(':id/suspend')
  suspend(@Req() req: any, @Param('id') id: string) {
    this.auth.suspendPartner(currentUserId(this.auth, req), id);
    return ok(null);
  }

  @Patch(':id/reactivate')
  reactivate(@Req() req: any, @Param('id') id: string) {
    this.auth.reactivatePartner(currentUserId(this.auth, req), id);
    return ok(null);
  }

  @Patch(':id/restore')
  restore(@Req() req: any, @Param('id') id: string) {
    this.auth.restorePartner(currentUserId(this.auth, req), id);
    return ok(null);
  }

  @Patch(':id')
  update(@Req() req: any, @Param('id') id: string, @Body() body: { name?: string; country?: string; website?: string | null; businessDescription?: string | null }) {
    return ok(this.auth.updatePartner(currentUserId(this.auth, req), id, body));
  }

  @Delete(':id/hard')
  @HttpCode(200)
  hardDelete(@Req() req: any, @Param('id') id: string) {
    this.auth.hardDeletePartner(currentUserId(this.auth, req), id);
    return ok(null);
  }

  @Get()
  partners(@Req() req: any, @Query() query: any) {
    return page(this.auth.listPartners(currentUserId(this.auth, req), normalizeQuery(query)));
  }

  @Get(':id')
  partner(@Req() req: any, @Param('id') id: string) {
    return ok(this.auth.getPartner(currentUserId(this.auth, req), id));
  }

  @Delete(':id')
  @HttpCode(200)
  softDelete(@Req() req: any, @Param('id') id: string) {
    this.auth.softDeletePartner(currentUserId(this.auth, req), id);
    return ok(null);
  }

  @Post(':id/customer-workspaces')
  @HttpCode(200)
  provisionWorkspace(@Req() req: any, @Param('id') id: string, @Body() body: { customerUserId: string; name: string }) {
    return ok(this.auth.provisionCustomerWorkspace(currentUserId(this.auth, req), id, body.customerUserId, body.name));
  }

  @Post(':id/workspaces/:workspaceId/access')
  @HttpCode(200)
  grantAccess(@Req() req: any, @Param('id') id: string, @Param('workspaceId') workspaceIdParam: string) {
    return ok(this.auth.grantPartnerWorkspaceAccess(currentUserId(this.auth, req), id, workspaceIdParam));
  }

  @Post(':id/workspaces/:workspaceId/relation')
  @HttpCode(200)
  createRelation(@Req() req: any, @Param('id') id: string, @Param('workspaceId') workspaceIdParam: string) {
    return ok(this.auth.createPartnerWorkspaceRelation(currentUserId(this.auth, req), id, workspaceIdParam));
  }

  @Get(':id/workspaces/:workspaceId/access')
  canAccess(@Req() req: any, @Param('id') id: string, @Param('workspaceId') workspaceIdParam: string) {
    return ok({ allowed: this.auth.canPartnerAccessWorkspace(currentUserId(this.auth, req), id, workspaceIdParam) });
  }

  @Delete('workspace-relations/:relationId')
  @HttpCode(200)
  endRelation(@Req() req: any, @Param('relationId') relationId: string) {
    this.auth.endPartnerWorkspaceRelation(currentUserId(this.auth, req), relationId);
    return ok(null);
  }

  @Delete('workspace-access/:accessId')
  @HttpCode(200)
  revokeAccess(@Req() req: any, @Param('accessId') accessId: string) {
    this.auth.revokePartnerWorkspaceAccess(currentUserId(this.auth, req), accessId);
    return ok(null);
  }
}
