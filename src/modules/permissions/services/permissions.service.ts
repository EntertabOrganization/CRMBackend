import { Inject, Injectable, Logger } from '@nestjs/common';
import { Permission } from '@prisma/client';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import { PaginatedResult } from '../../../common/interfaces/paginated-result.interface';
import { buildPaginatedResult, buildPaginationParams, buildWhereWithSoftDelete } from '../../../common/utils/pagination.util';
import { PERMISSIONS_REPOSITORY } from '../constants/permissions.tokens';
import { CreatePermissionDto } from '../dto/create-permission.dto';
import { UpdatePermissionDto } from '../dto/update-permission.dto';
import {
  PermissionAlreadyActiveException,
  PermissionAlreadyDeletedException,
  PermissionAlreadyExistsException,
  PermissionNotFoundException,
  PermissionSoftDeletedConflictException,
} from '../exceptions/permission.exceptions';
import { PermissionsRepository } from '../interfaces/permissions-repository.interface';
import { PermissionsCacheService } from './permissions-cache.service';

@Injectable()
export class PermissionsService {
  private readonly logger = new Logger(PermissionsService.name);

  constructor(
    @Inject(PERMISSIONS_REPOSITORY)
    private readonly permissionsRepository: PermissionsRepository,
    private readonly permissionsCacheService: PermissionsCacheService,
  ) {}

  async create(createPermissionDto: CreatePermissionDto): Promise<Permission> {
    try {
      await this.ensureSlugAvailable(createPermissionDto.slug);

      const permission = await this.permissionsRepository.create({
        ...createPermissionDto,
        isDeleted: false,
      });

      this.permissionsCacheService.invalidatePermission(permission.id);
      this.permissionsCacheService.setPermission(permission);
      return permission;
    } catch (error) {
      this.logger.error('Error creating permission', error instanceof Error ? error.stack : String(error));
      throw error;
    }
  }

  async findAll(paginationDto: PaginationDto): Promise<PaginatedResult<Permission>> {
    const where = buildWhereWithSoftDelete(paginationDto.filters, paginationDto.is_deleted);
    const pagination = buildPaginationParams(paginationDto, 'name');
    const cacheKey = JSON.stringify({
      where,
      pagination,
      page: paginationDto.page,
      limit: paginationDto.limit,
      sortOrder: paginationDto.sortOrder,
    });

    const cachedPermissions = this.permissionsCacheService.getCollection<PaginatedResult<Permission>>(cacheKey);
    if (cachedPermissions) {
      return cachedPermissions;
    }

    const [data, total] = await Promise.all([
      this.permissionsRepository.findMany({
        where,
        ...pagination,
      }),
      this.permissionsRepository.count(where),
    ]);

    const result = buildPaginatedResult(data, total, paginationDto);
    this.permissionsCacheService.setCollection(cacheKey, result);
    return result;
  }

  async findOne(id: string): Promise<Permission> {
    const cachedPermission = this.permissionsCacheService.getPermission(id);
    if (cachedPermission) {
      return cachedPermission;
    }

    const permission = await this.getPermissionOrThrow(id);
    this.permissionsCacheService.setPermission(permission);
    return permission;
  }

  async update(id: string, updatePermissionDto: UpdatePermissionDto): Promise<Permission> {
    try {
      const permission = await this.getPermissionOrThrow(id);

      if (updatePermissionDto.slug && updatePermissionDto.slug !== permission.slug) {
        await this.ensureSlugAvailable(updatePermissionDto.slug, permission.id);
      }

      const updatedPermission = await this.permissionsRepository.update({ id }, updatePermissionDto);
      this.permissionsCacheService.invalidatePermission(id);
      this.permissionsCacheService.setPermission(updatedPermission);
      return updatedPermission;
    } catch (error) {
      this.logger.error(`Error updating permission with id ${id}`, error instanceof Error ? error.stack : String(error));
      throw error;
    }
  }

  async softRemove(id: string): Promise<Permission> {
    try {
      const permission = await this.getPermissionIncludingDeletedOrThrow(id);

      if (permission.isDeleted) {
        throw new PermissionAlreadyDeletedException(id);
      }

      const deletedPermission = await this.permissionsRepository.update({ id }, {
        isDeleted: true,
      });
      this.permissionsCacheService.invalidatePermission(id);
      return deletedPermission;
    } catch (error) {
      this.logger.error(`Error soft deleting permission with id ${id}`, error instanceof Error ? error.stack : String(error));
      throw error;
    }
  }

  async hardRemove(id: string): Promise<Permission> {
    try {
      await this.getPermissionIncludingDeletedOrThrow(id);
      const deletedPermission = await this.permissionsRepository.delete({ id });
      this.permissionsCacheService.invalidatePermission(id);
      return deletedPermission;
    } catch (error) {
      this.logger.error(`Error hard deleting permission with id ${id}`, error instanceof Error ? error.stack : String(error));
      throw error;
    }
  }

  async restore(id: string): Promise<Permission> {
    try {
      const permission = await this.getPermissionIncludingDeletedOrThrow(id);

      if (!permission.isDeleted) {
        throw new PermissionAlreadyActiveException(id);
      }

      const restoredPermission = await this.permissionsRepository.update({ id }, {
        isDeleted: false,
      });
      this.permissionsCacheService.invalidatePermission(id);
      this.permissionsCacheService.setPermission(restoredPermission);
      return restoredPermission;
    } catch (error) {
      this.logger.error(`Error restoring permission with id ${id}`, error instanceof Error ? error.stack : String(error));
      throw error;
    }
  }

  private async getPermissionOrThrow(id: string): Promise<Permission> {
    const permission = await this.permissionsRepository.findById(id);

    if (!permission) {
      throw new PermissionNotFoundException(id);
    }

    return permission;
  }

  private async getPermissionIncludingDeletedOrThrow(id: string): Promise<Permission> {
    const permission = await this.permissionsRepository.findById(id, { includeDeleted: true });

    if (!permission) {
      throw new PermissionNotFoundException(id);
    }

    return permission;
  }

  private async ensureSlugAvailable(slug: string, currentPermissionId?: string): Promise<void> {
    const existingPermission = await this.permissionsRepository.findBySlug(slug, { includeDeleted: true });

    if (!existingPermission || existingPermission.id === currentPermissionId) {
      return;
    }

    if (existingPermission.isDeleted) {
      throw new PermissionSoftDeletedConflictException(slug);
    }

    throw new PermissionAlreadyExistsException(slug);
  }
}
