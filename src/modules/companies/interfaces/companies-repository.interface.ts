import { Company, Prisma } from '@prisma/client';
import { BaseRepository, RepositoryFindOptions } from '../../../infrastructure/database/repositories/base-repository.interface';

export interface CompaniesRepository
  extends BaseRepository<
    Company,
    Prisma.CompanyWhereInput,
    Prisma.CompanyUncheckedCreateInput,
    Prisma.CompanyUncheckedUpdateInput,
    Prisma.CompanyOrderByWithRelationInput,
    Prisma.CompanyWhereUniqueInput
  > {
  findByOwnerId(ownerId: string, options?: RepositoryFindOptions): Promise<Company | null>;
}
