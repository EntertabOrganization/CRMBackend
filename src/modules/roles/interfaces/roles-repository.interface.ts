import { Prisma } from '@prisma/client';
import { BaseRepository, RepositoryFindOptions } from '../../../infrastructure/database/repositories/base-repository.interface';

export type RoleWithPermissions = Prisma.RoleGetPayload<{
  include: {
    permissions: {
      include: {
        permission: {
          select: {
            id: true;
            name: true;
            description: true;
          };
        };
      };
    };
  };
}>;

export interface CreateRoleRepositoryInput {
  name: string;
  description?: string;
  companyId?: string;
  permissions: string[];
  isDeleted: boolean;
}

export interface UpdateRoleRepositoryInput {
  name?: string;
  description?: string;
  permissions?: string[];
  isDeleted?: boolean;
}

export interface RolesRepository
  extends BaseRepository<
    RoleWithPermissions,
    Prisma.RoleWhereInput,
    CreateRoleRepositoryInput,
    UpdateRoleRepositoryInput,
    Prisma.RoleOrderByWithRelationInput,
    Prisma.RoleWhereUniqueInput
  > {
  findByName(name: string, companyId: string, options?: RepositoryFindOptions): Promise<RoleWithPermissions | null>;
}
