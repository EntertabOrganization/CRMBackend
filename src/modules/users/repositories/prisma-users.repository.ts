import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AuthUserRecord,
  CreateUserRepositoryInput,
  UpdateUserRepositoryInput,
  UserWithRelations,
  UsersRepository,
  authUserSelect,
  userSelect,
} from '../interfaces/users-repository.interface';
import { FindManyParams, RepositoryFindOptions } from '../../../infrastructure/database/repositories/base-repository.interface';
import { PrismaService } from '../../../infrastructure/database/prisma.service';

@Injectable()
export class PrismaUsersRepository implements UsersRepository {
  constructor(private readonly prisma: PrismaService) {}

  findById(id: string, options: RepositoryFindOptions = {}): Promise<UserWithRelations | null> {
    if (options.includeDeleted) {
      return this.prisma.user.findUnique({
        where: { id },
        select: userSelect,
      });
    }

    return this.prisma.user.findFirst({
      where: {
        id,
        isDeleted: false,
      },
      select: userSelect,
    });
  }

  findOne(where: Prisma.UserWhereInput, options: RepositoryFindOptions = {}): Promise<UserWithRelations | null> {
    return this.prisma.user.findFirst({
      where: this.applySoftDeleteFilter(where, options),
      select: userSelect,
    });
  }

  findMany(
    params: FindManyParams<Prisma.UserWhereInput, Prisma.UserOrderByWithRelationInput>,
    options: RepositoryFindOptions = {},
  ): Promise<UserWithRelations[]> {
    return this.prisma.user.findMany({
      ...params,
      where: this.applySoftDeleteFilter(params.where, options),
      select: userSelect,
    });
  }

  count(where?: Prisma.UserWhereInput, options: RepositoryFindOptions = {}): Promise<number> {
    return this.prisma.user.count({
      where: this.applySoftDeleteFilter(where, options),
    });
  }

  create(data: CreateUserRepositoryInput): Promise<UserWithRelations> {
    return this.prisma.user.create({
      data: {
        firstName: data.firstName,
        lastName: data.lastName,
        email: data.email,
        password: data.password,
        profilePic: data.profilePic,
        phoneNumber: data.phoneNumber,
        dateOfBirth: data.dateOfBirth,
        companyId: data.companyId ?? null,
        isDeleted: data.isDeleted,
        deletedAt: data.deletedAt ?? null,
        ...(data.roleId
          ? {
              roles: {
                create: {
                  isDeleted: false,
                  role: {
                    connect: { id: data.roleId },
                  },
                },
              },
            }
          : {}),
      },
      select: userSelect,
    });
  }

  update(where: Prisma.UserWhereUniqueInput, data: UpdateUserRepositoryInput): Promise<UserWithRelations> {
    const userData: Prisma.UserUpdateInput = {
      ...(data.firstName !== undefined ? { firstName: data.firstName } : {}),
      ...(data.lastName !== undefined ? { lastName: data.lastName } : {}),
      ...(data.email !== undefined ? { email: data.email } : {}),
      ...(data.password !== undefined ? { password: data.password } : {}),
      ...(data.profilePic !== undefined ? { profilePic: data.profilePic } : {}),
      ...(data.phoneNumber !== undefined ? { phoneNumber: data.phoneNumber } : {}),
      ...(data.dateOfBirth !== undefined ? { dateOfBirth: data.dateOfBirth } : {}),
      ...(data.isDeleted !== undefined ? { isDeleted: data.isDeleted } : {}),
      ...(data.deletedAt !== undefined ? { deletedAt: data.deletedAt } : {}),
      ...(data.roleId !== undefined
        ? {
            roles: {
              deleteMany: {},
              create: {
                isDeleted: false,
                role: {
                  connect: { id: data.roleId },
                },
              },
            },
          }
        : {}),
    };

    return this.prisma.user.update({
      where,
      data: userData,
      select: userSelect,
    });
  }

  delete(where: Prisma.UserWhereUniqueInput): Promise<UserWithRelations> {
    return this.prisma.user.delete({
      where,
      select: userSelect,
    });
  }

  findByEmail(email: string, options: RepositoryFindOptions = {}): Promise<UserWithRelations | null> {
    return this.prisma.user.findFirst({
      where: this.applySoftDeleteFilter({ email }, options),
      select: userSelect,
    });
  }

  findAuthByEmail(email: string, options: RepositoryFindOptions = {}): Promise<AuthUserRecord | null> {
    return this.prisma.user.findFirst({
      where: this.applySoftDeleteFilter({ email }, options),
      select: authUserSelect,
    });
  }

  private applySoftDeleteFilter(where?: Prisma.UserWhereInput, options: RepositoryFindOptions = {}): Prisma.UserWhereInput {
    if (options.includeDeleted) {
      return where ?? {};
    }

    return {
      ...(where ?? {}),
      isDeleted: false,
    };
  }
}
