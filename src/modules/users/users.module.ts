import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { USERS_REPOSITORY } from './constants/users.tokens';
import { AuthController } from './controllers/auth.controller';
import { UsersController } from './controllers/users.controller';
import { PrismaUsersRepository } from './repositories/prisma-users.repository';
import { AuthService } from './services/auth.service';
import { UsersCacheService } from './services/users-cache.service';
import { UsersService } from './services/users.service';

@Module({
  imports: [DatabaseModule],
  controllers: [UsersController, AuthController],
  providers: [
    UsersService,
    AuthService,
    UsersCacheService,
    PrismaUsersRepository,
    {
      provide: USERS_REPOSITORY,
      useExisting: PrismaUsersRepository,
    },
  ],
  exports: [UsersService, AuthService],
})
export class UsersModule {}
