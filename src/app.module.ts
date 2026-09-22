import { Module } from '@nestjs/common';
import { AuditController } from './modules/auth/http/audit.controller';
import { AuthHttpController } from './modules/auth/http/auth.controller';
import { AuthDomainService } from './modules/auth/http/auth-domain.service';
import { AuthorizationController } from './modules/auth/http/authorization.controller';
import { DepartmentController } from './modules/auth/http/department.controller';
import { PartnerController } from './modules/auth/http/partner.controller';
import { UserController } from './modules/auth/http/user.controller';
import { WorkspaceController } from './modules/auth/http/workspace.controller';

@Module({
  controllers: [
    AuthHttpController,
    WorkspaceController,
    AuthorizationController,
    UserController,
    DepartmentController,
    PartnerController,
    AuditController,
  ],
  providers: [AuthDomainService],
})
export class AppModule {}
