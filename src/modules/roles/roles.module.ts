import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { ROLES_REPOSITORY } from './constants/roles.tokens';
import { RolesController } from './controllers/roles.controller';
import { PrismaRolesRepository } from './repositories/prisma-roles.repository';
import { RolesCacheService } from './services/roles-cache.service';
import { RolesService } from './services/roles.service';

@Module({
  imports: [DatabaseModule],
  controllers: [RolesController],
  providers: [
    RolesService,
    RolesCacheService,
    PrismaRolesRepository,
    {
      provide: ROLES_REPOSITORY,
      useExisting: PrismaRolesRepository,
    },
  ],
  exports: [RolesService],
})
export class RolesModule {}
