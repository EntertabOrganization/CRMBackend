import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PaginatedResult } from '../../../common/interfaces/paginated-result.interface';
import { buildPaginatedResult, buildPaginationParams, buildWhereWithSoftDelete } from '../../../common/utils/pagination.util';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { ROLES_REPOSITORY } from '../constants/roles.tokens';
import { CreateRoleDto } from '../dto/create-role.dto';
import { RolesPaginationDto } from '../dto/roles-pagination.dto';
import { UpdateRoleDto } from '../dto/update-role.dto';
import {
  RoleAlreadyActiveException,
  RoleAlreadyDeletedException,
  RoleAlreadyExistsException,
  RoleNotFoundException,
  RolePermissionsNotFoundException,
  RolesSchemaOutdatedException,
  RoleUnauthorizedCompanyScopeException,
} from '../exceptions/role.exceptions';
import { RoleWithPermissions, RolesRepository } from '../interfaces/roles-repository.interface';
import { RolesCacheService } from './roles-cache.service';

@Injectable()
export class RolesService {
  private readonly logger = new Logger(RolesService.name);

  constructor(
    @Inject(ROLES_REPOSITORY)
    private readonly rolesRepository: RolesRepository,
    private readonly rolesCacheService: RolesCacheService,
    private readonly prisma: PrismaService,
  ) {}

  async create(createRoleDto: CreateRoleDto): Promise<RoleWithPermissions> {
    try {
      await this.ensureRoleNameAvailable(createRoleDto.name, createRoleDto.companyId);
      await this.ensurePermissionsExist(createRoleDto.permissions);

      const role = await this.rolesRepository.create({
        ...createRoleDto,
        isDeleted: false,
      });

      this.rolesCacheService.invalidateRole(role.companyId, role.id);
      this.rolesCacheService.setRole(role);
      return role;
    } catch (error) {
      this.logger.error('Error creating role', error instanceof Error ? error.stack : String(error));
      throw this.mapPersistenceError(error);
    }
  }

  async findAll(paginationDto: RolesPaginationDto): Promise<PaginatedResult<RoleWithPermissions>> {
    const where = buildWhereWithSoftDelete(
      {
        ...(paginationDto.filters ?? {}),
        companyId: paginationDto.companyId,
      },
      paginationDto.is_deleted,
    );
    const pagination = buildPaginationParams(paginationDto, 'name');
    const cacheKey = JSON.stringify({
      where,
      pagination,
      page: paginationDto.page,
      limit: paginationDto.limit,
      sortOrder: paginationDto.sortOrder,
    });

    const cachedRoles = this.rolesCacheService.getCollection<PaginatedResult<RoleWithPermissions>>(
      paginationDto.companyId,
      cacheKey,
    );
    if (cachedRoles) {
      return cachedRoles;
    }

    const [data, total] = await Promise.all([
      this.rolesRepository.findMany({
        where,
        ...pagination,
      }),
      this.rolesRepository.count(where),
    ]);

    const result = buildPaginatedResult(data, total, paginationDto);
    this.rolesCacheService.setCollection(paginationDto.companyId, cacheKey, result);
    return result;
  }

  async findOne(id: string, companyId: string): Promise<RoleWithPermissions> {
    const cachedRole = this.rolesCacheService.getRole(companyId, id);
    if (cachedRole) {
      return cachedRole;
    }

    const role = await this.getRoleInCompanyOrThrow(id, companyId);
    this.rolesCacheService.setRole(role);
    return role;
  }

  async update(id: string, companyId: string, updateRoleDto: UpdateRoleDto): Promise<RoleWithPermissions> {
    try {
      const role = await this.getRoleInCompanyOrThrow(id, companyId, { includeDeleted: false });

      if (updateRoleDto.name && updateRoleDto.name !== role.name) {
        await this.ensureRoleNameAvailable(updateRoleDto.name, companyId, role.id);
      }

      if (updateRoleDto.permissions) {
        await this.ensurePermissionsExist(updateRoleDto.permissions);
      }

      const updatedRole = await this.rolesRepository.update(
        { id },
        {
          name: updateRoleDto.name,
          description: updateRoleDto.description,
          permissions: updateRoleDto.permissions,
        },
      );

      this.rolesCacheService.invalidateRole(companyId, id);
      this.rolesCacheService.setRole(updatedRole);
      return updatedRole;
    } catch (error) {
      this.logger.error(`Error updating role with id ${id}`, error instanceof Error ? error.stack : String(error));
      throw this.mapPersistenceError(error);
    }
  }

  async softRemove(id: string, companyId: string): Promise<RoleWithPermissions> {
    try {
      const role = await this.getRoleInCompanyOrThrow(id, companyId, { includeDeleted: true });

      if (role.isDeleted) {
        throw new RoleAlreadyDeletedException(id);
      }

      const deletedRole = await this.rolesRepository.update({ id }, { isDeleted: true });
      this.rolesCacheService.invalidateRole(companyId, id);
      return deletedRole;
    } catch (error) {
      this.logger.error(`Error soft deleting role with id ${id}`, error instanceof Error ? error.stack : String(error));
      throw this.mapPersistenceError(error);
    }
  }

  async hardRemove(id: string, companyId: string): Promise<RoleWithPermissions> {
    try {
      await this.getRoleInCompanyOrThrow(id, companyId, { includeDeleted: true });
      const deletedRole = await this.rolesRepository.delete({ id });
      this.rolesCacheService.invalidateRole(companyId, id);
      return deletedRole;
    } catch (error) {
      this.logger.error(`Error hard deleting role with id ${id}`, error instanceof Error ? error.stack : String(error));
      throw this.mapPersistenceError(error);
    }
  }

  async restore(id: string, companyId: string): Promise<RoleWithPermissions> {
    try {
      const role = await this.getRoleInCompanyOrThrow(id, companyId, { includeDeleted: true });

      if (!role.isDeleted) {
        throw new RoleAlreadyActiveException(id);
      }

      const restoredRole = await this.rolesRepository.update({ id }, { isDeleted: false });
      this.rolesCacheService.invalidateRole(companyId, id);
      this.rolesCacheService.setRole(restoredRole);
      return restoredRole;
    } catch (error) {
      this.logger.error(`Error restoring role with id ${id}`, error instanceof Error ? error.stack : String(error));
      throw this.mapPersistenceError(error);
    }
  }

  private async getRoleInCompanyOrThrow(
    id: string,
    companyId: string,
    options: { includeDeleted: boolean },
  ): Promise<RoleWithPermissions>;
  private async getRoleInCompanyOrThrow(id: string, companyId: string): Promise<RoleWithPermissions>;
  private async getRoleInCompanyOrThrow(
    id: string,
    companyId: string,
    options: { includeDeleted?: boolean } = {},
  ): Promise<RoleWithPermissions> {
    const role = await this.rolesRepository.findById(id, { includeDeleted: options.includeDeleted });

    if (!role) {
      throw new RoleNotFoundException(id);
    }

    if (role.companyId !== companyId) {
      throw new RoleUnauthorizedCompanyScopeException(id, companyId);
    }

    return role;
  }

  private async ensureRoleNameAvailable(name: string, companyId: string, currentRoleId?: string): Promise<void> {
    const existingRole = await this.rolesRepository.findByName(name, companyId, { includeDeleted: true });

    if (!existingRole || existingRole.id === currentRoleId) {
      return;
    }

    throw new RoleAlreadyExistsException(name, companyId);
  }

  private async ensurePermissionsExist(permissionIds: string[]): Promise<void> {
    const uniquePermissionIds = [...new Set(permissionIds)];

    const totalPermissions = await this.prisma.permission.count({
      where: {
        id: {
          in: uniquePermissionIds,
        },
        isDeleted: false,
      },
    });

    if (totalPermissions !== uniquePermissionIds.length) {
      throw new RolePermissionsNotFoundException();
    }
  }

  private mapPersistenceError(error: unknown): unknown {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
      return error;
    }

    if (error.code === 'P2022') {
      return new RolesSchemaOutdatedException();
    }

    return error;
  }
}
