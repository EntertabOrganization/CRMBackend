import { Injectable } from '@nestjs/common';
import { Permission, Prisma } from '@prisma/client';
import { PrismaSoftDeleteRepository } from '../../../infrastructure/database/repositories/prisma-soft-delete.repository';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { RepositoryFindOptions } from '../../../infrastructure/database/repositories/base-repository.interface';
import { PermissionsRepository } from '../interfaces/permissions-repository.interface';

@Injectable()
export class PrismaPermissionsRepository
  extends PrismaSoftDeleteRepository<
    Permission,
    Prisma.PermissionWhereInput,
    Prisma.PermissionCreateInput,
    Prisma.PermissionUpdateInput,
    Prisma.PermissionOrderByWithRelationInput,
    Prisma.PermissionWhereUniqueInput
  >
  implements PermissionsRepository
{
  constructor(private readonly prisma: PrismaService) {
    super(prisma.permission, {
      buildIdWhere: (id: string) => ({ id }),
    });
  }

  findBySlug(slug: string, options: RepositoryFindOptions = {}): Promise<Permission | null> {
    if (options.includeDeleted) {
      return this.findUnique({ slug });
    }

    return this.findOne({ slug }, options);
  }
}
