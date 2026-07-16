import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { COMPANIES_REPOSITORY } from './constants/companies.tokens';
import { CompaniesController } from './controllers/companies.controller';
import { PrismaCompaniesRepository } from './repositories/prisma-companies.repository';
import { CompaniesCacheService } from './services/companies-cache.service';
import { CompaniesService } from './services/companies.service';

@Module({
  imports: [DatabaseModule],
  controllers: [CompaniesController],
  providers: [
    CompaniesService,
    CompaniesCacheService,
    PrismaCompaniesRepository,
    {
      provide: COMPANIES_REPOSITORY,
      useExisting: PrismaCompaniesRepository,
    },
  ],
  exports: [CompaniesService],
})
export class CompaniesModule {}
