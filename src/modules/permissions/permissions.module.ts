import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { PERMISSIONS_REPOSITORY } from './constants/permissions.tokens';
import { PermissionsController } from './controllers/permissions.controller';
import { PrismaPermissionsRepository } from './repositories/prisma-permissions.repository';
import { PermissionsCacheService } from './services/permissions-cache.service';
import { PermissionsService } from './services/permissions.service';

@Module({
  imports: [DatabaseModule],
  controllers: [PermissionsController],
  providers: [
    PermissionsService,
    PermissionsCacheService,
    PrismaPermissionsRepository,
    {
      provide: PERMISSIONS_REPOSITORY,
      useExisting: PrismaPermissionsRepository,
    },
  ],
  exports: [PermissionsService],
})
export class PermissionsModule {}
