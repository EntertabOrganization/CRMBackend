import { Injectable } from '@nestjs/common';
import { Company, Prisma } from '@prisma/client';
import { RepositoryFindOptions } from '../../../infrastructure/database/repositories/base-repository.interface';
import { PrismaSoftDeleteRepository } from '../../../infrastructure/database/repositories/prisma-soft-delete.repository';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { CompaniesRepository } from '../interfaces/companies-repository.interface';

@Injectable()
export class PrismaCompaniesRepository
  extends PrismaSoftDeleteRepository<
    Company,
    Prisma.CompanyWhereInput,
    Prisma.CompanyUncheckedCreateInput,
    Prisma.CompanyUncheckedUpdateInput,
    Prisma.CompanyOrderByWithRelationInput,
    Prisma.CompanyWhereUniqueInput
  >
  implements CompaniesRepository
{
  constructor(private readonly prisma: PrismaService) {
    super(prisma.company, {
      buildIdWhere: (id: string) => ({ id }),
    });
  }

  findByOwnerId(ownerId: string, options: RepositoryFindOptions = {}): Promise<Company | null> {
    if (options.includeDeleted) {
      return this.findUnique({ ownerId } as unknown as Prisma.CompanyWhereUniqueInput);
    }

    return this.findOne({ ownerId } as unknown as Prisma.CompanyWhereInput, options);
  }
}
