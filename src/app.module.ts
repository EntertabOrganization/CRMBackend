import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import appConfig from './config/app.config';
import companiesConfig from './config/companies.config';
import permissionsConfig from './config/permissions.config';
import rolesConfig from './config/roles.config';
import throttlerConfig from './config/throttler.config';
import usersConfig from './config/users.config';
import { DatabaseModule } from './infrastructure/database/database.module';
import { CompaniesModule } from './modules/companies/companies.module';
import { PermissionsModule } from './modules/permissions/permissions.module';
import { RolesModule } from './modules/roles/roles.module';
import { UsersModule } from './modules/users/users.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { PermissionsGuard } from './common/guards/permissions.guard';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, throttlerConfig, permissionsConfig, companiesConfig, rolesConfig, usersConfig],
    }),
    EventEmitterModule.forRoot(),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => [
        {
          name: 'default',
          ttl: configService.getOrThrow<number>('throttler.defaultTtl'),
          limit: configService.getOrThrow<number>('throttler.defaultLimit'),
        },
      ],
    }),
    DatabaseModule,
    CompaniesModule,
    PermissionsModule,
    RolesModule,
    UsersModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: PermissionsGuard,
    },
  ],
})
export class AppModule {}
