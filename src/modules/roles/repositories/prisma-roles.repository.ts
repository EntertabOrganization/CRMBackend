import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  CreateRoleRepositoryInput,
  RoleWithPermissions,
  RolesRepository,
  UpdateRoleRepositoryInput,
} from '../interfaces/roles-repository.interface';
import { FindManyParams, RepositoryFindOptions } from '../../../infrastructure/database/repositories/base-repository.interface';
import { PrismaService } from '../../../infrastructure/database/prisma.service';

const roleInclude = {
  permissions: {
    where: {
      isDeleted: false,
      permission: {
        isDeleted: false,
      },
    },
    include: {
      permission: {
        select: {
          id: true,
          name: true,
          description: true,
        },
      },
    },
  },
} satisfies Prisma.RoleInclude;

@Injectable()
export class PrismaRolesRepository implements RolesRepository {
  constructor(private readonly prisma: PrismaService) {}

  findById(id: string, options: RepositoryFindOptions = {}): Promise<RoleWithPermissions | null> {
    if (options.includeDeleted) {
      return this.prisma.role.findUnique({
        where: { id },
        include: roleInclude,
      });
    }

    return this.prisma.role.findFirst({
      where: {
        id,
        isDeleted: false,
      },
      include: roleInclude,
    });
  }

  findOne(where: Prisma.RoleWhereInput, options: RepositoryFindOptions = {}): Promise<RoleWithPermissions | null> {
    return this.prisma.role.findFirst({
      where: this.applySoftDeleteFilter(where, options),
      include: roleInclude,
    });
  }

  findMany(
    params: FindManyParams<Prisma.RoleWhereInput, Prisma.RoleOrderByWithRelationInput>,
    options: RepositoryFindOptions = {},
  ): Promise<RoleWithPermissions[]> {
    return this.prisma.role.findMany({
      ...params,
      where: this.applySoftDeleteFilter(params.where, options),
      include: roleInclude,
    });
  }

  count(where?: Prisma.RoleWhereInput, options: RepositoryFindOptions = {}): Promise<number> {
    return this.prisma.role.count({
      where: this.applySoftDeleteFilter(where, options),
    });
  }

  create(data: CreateRoleRepositoryInput): Promise<RoleWithPermissions> {
    return this.prisma.role.create({
      data: {
        name: data.name,
        description: data.description,
        companyId: data.companyId,
        isDeleted: data.isDeleted,
        permissions: {
          create: data.permissions.map((permissionId) => ({
            isDeleted: false,
            permission: {
              connect: { id: permissionId },
            },
          })),
        },
      },
      include: roleInclude,
    });
  }

  update(where: Prisma.RoleWhereUniqueInput, data: UpdateRoleRepositoryInput): Promise<RoleWithPermissions> {
    const roleData: Prisma.RoleUpdateInput = {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.description !== undefined ? { description: data.description } : {}),
      ...(data.isDeleted !== undefined ? { isDeleted: data.isDeleted } : {}),
      ...(data.permissions !== undefined
        ? {
            permissions: {
              deleteMany: {},
              create: data.permissions.map((permissionId) => ({
                isDeleted: false,
                permission: {
                  connect: { id: permissionId },
                },
              })),
            },
          }
        : {}),
    };

    return this.prisma.role.update({
      where,
      data: roleData,
      include: roleInclude,
    });
  }

  delete(where: Prisma.RoleWhereUniqueInput): Promise<RoleWithPermissions> {
    return this.prisma.role.delete({
      where,
      include: roleInclude,
    });
  }

  findByName(name: string, companyId: string, options: RepositoryFindOptions = {}): Promise<RoleWithPermissions | null> {
    return this.prisma.role.findFirst({
      where: this.applySoftDeleteFilter(
        {
          name,
          companyId,
        },
        options,
      ),
      include: roleInclude,
    });
  }

  private applySoftDeleteFilter(where?: Prisma.RoleWhereInput, options: RepositoryFindOptions = {}): Prisma.RoleWhereInput {
    if (options.includeDeleted) {
      return where ?? {};
    }

    return {
      ...(where ?? {}),
      isDeleted: false,
    };
  }
}
