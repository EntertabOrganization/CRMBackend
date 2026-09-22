import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import { AuthDomainService } from './auth-domain.service';
import { currentUserId, normalizeQuery, ok, page, workspaceId } from './http-utils';

@Controller('audit-logs')
export class AuditController {
  constructor(private readonly auth: AuthDomainService) {}

  @Get()
  list(@Req() req: any, @Query() query: any) {
    return page(this.auth.listAuditLogs(currentUserId(this.auth, req), workspaceId(req), normalizeQuery(query)));
  }

  @Get(':id')
  get(@Req() req: any, @Param('id') id: string) {
    const userId = currentUserId(this.auth, req);
    const ws = workspaceId(req);
    this.auth.listAuditLogs(userId, ws, { limit: 1 });
    const log = this.auth.state.auditLogs.find((l) => l.id === id && l.workspaceId === ws);
    return ok(log);
  }
}
