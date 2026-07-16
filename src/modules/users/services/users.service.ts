import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as crypto from 'crypto';
import { PaginatedResult } from '../../../common/interfaces/paginated-result.interface';
import { JwtPayload } from '../../../common/guards/jwt-auth.guard';
import { buildPaginatedResult, buildPaginationParams, buildWhereWithSoftDelete } from '../../../common/utils/pagination.util';
import { USERS_REPOSITORY } from '../constants/users.tokens';
import { CreateUserDto } from '../dto/create-user.dto';
import { UpdateUserDto } from '../dto/update-user.dto';
import { UsersPaginationDto } from '../dto/users-pagination.dto';
import {
  UserAlreadyActiveException,
  UserAlreadyDeletedException,
  UserEmailAlreadyExistsException,
  UserNotFoundException,
  UserRoleScopeInvalidException,
  UsersSchemaOutdatedException,
  UserUnauthorizedCompanyScopeException,
} from '../exceptions/user.exceptions';
import { UserWithRelations, UsersRepository } from '../interfaces/users-repository.interface';
import { UsersCacheService } from './users-cache.service';
import { PrismaService } from '../../../infrastructure/database/prisma.service';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @Inject(USERS_REPOSITORY)
    private readonly usersRepository: UsersRepository,
    private readonly usersCacheService: UsersCacheService,
    private readonly prisma: PrismaService,
  ) {}

  async create(createUserDto: CreateUserDto, companyId?: string): Promise<UserWithRelations> {
    try {
      await this.ensureEmailAvailable(createUserDto.email);

      // Convert dateOfBirth string to Date if provided and valid
      let dateOfBirth: Date | undefined = undefined;
      if (createUserDto.dateOfBirth && createUserDto.dateOfBirth.trim() !== '') {
        const parsed = new Date(createUserDto.dateOfBirth);
        dateOfBirth = isNaN(parsed.getTime()) ? undefined : parsed;
      }

      // Hash the password
      const hashedPassword = this.hashPassword(createUserDto.password);

      const user = await this.usersRepository.create({
        ...createUserDto,
        password: hashedPassword,
        dateOfBirth,
        companyId: companyId ?? null,
        roleId: createUserDto.roleId,
        isDeleted: false,
        deletedAt: null,
      });

      const scopeKey = this.usersCacheService.buildScopeKey(user.companyId);
      this.usersCacheService.invalidateUser(scopeKey, user.id);
      this.usersCacheService.setUser(user);
      return user;
    } catch (error) {
      this.logger.error('Error creating user', error instanceof Error ? error.stack : String(error));
      throw this.mapPersistenceError(error);
    }
  }

  async findAll(paginationDto: UsersPaginationDto, currentUser?: JwtPayload): Promise<PaginatedResult<UserWithRelations>> {
    const scopeKey = this.usersCacheService.buildScopeKey(paginationDto.companyId);
    const whereFilters: any = {
      ...(paginationDto.filters ?? {}),
    };

    // If companyId is explicitly provided in query, use it
    if (paginationDto.companyId) {
      whereFilters.companyId = paginationDto.companyId;
    } else if (currentUser?.companyId) {
      // Filter by user's company by default
      whereFilters.companyId = currentUser.companyId;
    }

    const where = buildWhereWithSoftDelete(
      whereFilters,
      paginationDto.is_deleted,
    );
    const pagination = buildPaginationParams(paginationDto, 'createdAt');
    const cacheKey = JSON.stringify({
      where,
      pagination,
      page: paginationDto.page,
      limit: paginationDto.limit,
      sortOrder: paginationDto.sortOrder,
    });

    const cachedUsers = this.usersCacheService.getCollection<PaginatedResult<UserWithRelations>>(scopeKey, cacheKey);
    if (cachedUsers) {
      return cachedUsers;
    }

    const [data, total] = await Promise.all([
      this.usersRepository.findMany({
        where,
        ...pagination,
      }),
      this.usersRepository.count(where),
    ]);

    const result = buildPaginatedResult(data, total, paginationDto);
    this.usersCacheService.setCollection(scopeKey, cacheKey, result);
    return result;
  }

  async findOne(id: string, companyId?: string): Promise<UserWithRelations> {
    const scopeKey = this.usersCacheService.buildScopeKey(companyId);
    const cachedUser = this.usersCacheService.getUser(scopeKey, id);
    if (cachedUser) {
      return cachedUser;
    }

    const user = await this.getUserInScopeOrThrow(id, companyId);
    this.usersCacheService.setUser(user);
    return user;
  }

  async update(id: string, companyId: string | undefined, updateUserDto: UpdateUserDto): Promise<UserWithRelations> {
    try {
      const user = await this.getUserInScopeOrThrow(id, companyId, { includeDeleted: false });

      if (updateUserDto.email && updateUserDto.email !== user.email) {
        await this.ensureEmailAvailable(updateUserDto.email, user.id);
      }

      // Role updates are now handled elsewhere; ignore roleIds
      const { roleIds, ...rest } = updateUserDto as any;

      const updatedUser = await this.usersRepository.update(
        { id },
        {
          ...rest,
          roleId: updateUserDto.roleId,
        },
      );

      this.invalidateBothScopes(user.companyId, updatedUser.companyId, id);
      this.usersCacheService.setUser(updatedUser);
      return updatedUser;
    } catch (error) {
      this.logger.error(`Error updating user with id ${id}`, error instanceof Error ? error.stack : String(error));
      throw this.mapPersistenceError(error);
    }
  }

  async softRemove(id: string, companyId?: string): Promise<UserWithRelations> {
    try {
      const user = await this.getUserInScopeOrThrow(id, companyId, { includeDeleted: true });

      if (user.isDeleted) {
        throw new UserAlreadyDeletedException(id);
      }

      const deletedUser = await this.usersRepository.update(
        { id },
        {
          isDeleted: true,
          deletedAt: new Date(),
        },
      );

      this.invalidateBothScopes(user.companyId, deletedUser.companyId, id);
      return deletedUser;
    } catch (error) {
      this.logger.error(`Error soft deleting user with id ${id}`, error instanceof Error ? error.stack : String(error));
      throw this.mapPersistenceError(error);
    }
  }

  async hardRemove(id: string, companyId?: string): Promise<UserWithRelations> {
    try {
      const user = await this.getUserInScopeOrThrow(id, companyId, { includeDeleted: true });
      const deletedUser = await this.usersRepository.delete({ id });
      this.invalidateBothScopes(user.companyId, deletedUser.companyId, id);
      return deletedUser;
    } catch (error) {
      this.logger.error(`Error hard deleting user with id ${id}`, error instanceof Error ? error.stack : String(error));
      throw this.mapPersistenceError(error);
    }
  }

  async restore(id: string, companyId?: string): Promise<UserWithRelations> {
    try {
      const user = await this.getUserInScopeOrThrow(id, companyId, { includeDeleted: true });

      if (!user.isDeleted) {
        throw new UserAlreadyActiveException(id);
      }

      const restoredUser = await this.usersRepository.update(
        { id },
        {
          isDeleted: false,
          deletedAt: null,
        },
      );

      this.invalidateBothScopes(user.companyId, restoredUser.companyId, id);
      this.usersCacheService.setUser(restoredUser);
      return restoredUser;
    } catch (error) {
      this.logger.error(`Error restoring user with id ${id}`, error instanceof Error ? error.stack : String(error));
      throw this.mapPersistenceError(error);
    }
  }

  private async getUserInScopeOrThrow(
    id: string,
    companyId: string | undefined,
    options: { includeDeleted: boolean },
  ): Promise<UserWithRelations>;
  private async getUserInScopeOrThrow(id: string, companyId?: string): Promise<UserWithRelations>;
  private async getUserInScopeOrThrow(
    id: string,
    companyId?: string,
    options: { includeDeleted?: boolean } = {},
  ): Promise<UserWithRelations> {
    const user = await this.usersRepository.findById(id, { includeDeleted: options.includeDeleted });

    if (!user) {
      throw new UserNotFoundException(id);
    }

    if ((user.companyId ?? null) !== (companyId ?? null)) {
      throw new UserUnauthorizedCompanyScopeException(id, companyId ?? null);
    }

    return user;
  }

  private async ensureEmailAvailable(email: string, currentUserId?: string): Promise<void> {
    const existingUser = await this.usersRepository.findAuthByEmail(email, { includeDeleted: true });

    if (!existingUser || existingUser.id === currentUserId) {
      return;
    }

    throw new UserEmailAlreadyExistsException(email);
  }

  private async ensureRolesValid(roleIds: string[] | undefined, companyId?: string): Promise<void> {
    if (roleIds === undefined) {
      return;
    }

    if (roleIds.length === 0) {
      return;
    }

    const uniqueRoleIds = [...new Set(roleIds)];
    const totalRoles = await this.prisma.role.count({
      where: {
        id: {
          in: uniqueRoleIds,
        },
        companyId: companyId ?? undefined,
        isDeleted: false,
      },
    });

    if (totalRoles !== uniqueRoleIds.length) {
      throw new UserRoleScopeInvalidException();
    }
  }

  private invalidateBothScopes(previousCompanyId: string | null, nextCompanyId: string | null, id: string): void {
    this.usersCacheService.invalidateUser(this.usersCacheService.buildScopeKey(previousCompanyId), id);

    if (previousCompanyId !== nextCompanyId) {
      this.usersCacheService.invalidateUser(this.usersCacheService.buildScopeKey(nextCompanyId), id);
    }
  }

  private mapPersistenceError(error: unknown): unknown {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
      return error;
    }

    if (error.code === 'P2002') {
      return new UserEmailAlreadyExistsException('unknown');
    }

    if (error.code === 'P2022') {
      return new UsersSchemaOutdatedException();
    }

    return error;
  }

  private hashPassword(password: string): string {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${hash}`;
  }
}
