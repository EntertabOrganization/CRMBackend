import { Permission, Prisma } from '@prisma/client';
import { BaseRepository, RepositoryFindOptions } from '../../../infrastructure/database/repositories/base-repository.interface';

export interface PermissionsRepository
  extends BaseRepository<
    Permission,
    Prisma.PermissionWhereInput,
    Prisma.PermissionCreateInput,
    Prisma.PermissionUpdateInput,
    Prisma.PermissionOrderByWithRelationInput,
    Prisma.PermissionWhereUniqueInput
  > {
  findBySlug(slug: string, options?: RepositoryFindOptions): Promise<Permission | null>;
}
