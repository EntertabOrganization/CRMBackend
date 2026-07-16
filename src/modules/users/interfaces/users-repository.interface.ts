import { Prisma } from '@prisma/client';
import { BaseRepository, RepositoryFindOptions } from '../../../infrastructure/database/repositories/base-repository.interface';

export const userSelect = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  companyId: true,
  createdAt: true,
  updatedAt: true,
  isDeleted: true,
  deletedAt: true,
  company: {
    select: {
      id: true,
      name: true,
      description: true,
      companyCategory: true,
    },
  },
  roles: {
    where: {
      isDeleted: false,
      role: {
        isDeleted: false,
      },
    },
    select: {
      roleId: true,
      role: {
        select: {
          id: true,
          name: true,
          description: true,
          companyId: true,
          permissions: {
            where: {
              isDeleted: false,
              permission: {
                isDeleted: false,
              },
            },
            select: {
              permission: {
                select: {
                  id: true,
                  slug: true,
                  name: true,
                  description: true,
                  module: true,
                },
              },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.UserSelect;

export const authUserSelect = {
  ...userSelect,
  password: true,
} satisfies Prisma.UserSelect;

export type UserWithRelations = Prisma.UserGetPayload<{
  select: typeof userSelect;
}>;

export type AuthUserRecord = Prisma.UserGetPayload<{
  select: typeof authUserSelect;
}>;

export interface CreateUserRepositoryInput {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  profilePic?: string;
  phoneNumber?: string;
  dateOfBirth?: Date;
  companyId?: string | null;
  roleId?: string;
  isDeleted: boolean;
  deletedAt?: Date | null;
}

export interface UpdateUserRepositoryInput {
  firstName?: string;
  lastName?: string;
  email?: string;
  password?: string;
  profilePic?: string | null;
  phoneNumber?: string | null;
  dateOfBirth?: Date | null;
  roleId?: string;
  isDeleted?: boolean;
  deletedAt?: Date | null;
}

export interface UsersRepository
  extends BaseRepository<
    UserWithRelations,
    Prisma.UserWhereInput,
    CreateUserRepositoryInput,
    UpdateUserRepositoryInput,
    Prisma.UserOrderByWithRelationInput,
    Prisma.UserWhereUniqueInput
  > {
  findByEmail(email: string, options?: RepositoryFindOptions): Promise<UserWithRelations | null>;
  findAuthByEmail(email: string, options?: RepositoryFindOptions): Promise<AuthUserRecord | null>;
}
