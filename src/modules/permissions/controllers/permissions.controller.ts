import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ApiPaginationQuery } from '../../../common/decorators/api-pagination-query.decorator';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import { resolveSensitiveThrottleConfig } from '../../../config/throttler.config';
import { CreatePermissionDto } from '../dto/create-permission.dto';
import { UpdatePermissionDto } from '../dto/update-permission.dto';
import { PermissionsService } from '../services/permissions.service';

const sensitiveThrottleConfig = resolveSensitiveThrottleConfig();

@ApiTags('Permissions')
@ApiBearerAuth('bearer')
@Controller({ path: 'permissions', version: '1' })
export class PermissionsController {
  constructor(private readonly permissionsService: PermissionsService) {}

  @ApiOperation({ summary: 'Create a new permission' })
  @ApiResponse({ status: 201, description: 'The permission has been successfully created.' })
  @ApiResponse({ status: 409, description: 'Permission slug already exists.' })
  @RequirePermissions('permissions_create')
  @Post()
  @Throttle({ default: sensitiveThrottleConfig })
  create(@Body() createPermissionDto: CreatePermissionDto) {
    return this.permissionsService.create(createPermissionDto);
  }

  @ApiOperation({ summary: 'Get all permissions' })
  @ApiResponse({ status: 200, description: 'Return all permissions.' })
  @RequirePermissions('permissions_read')
  @Get()
  @ApiPaginationQuery()
  findAll(@Query() query: PaginationDto) {
    return this.permissionsService.findAll(query);
  }

  @ApiOperation({ summary: 'Get a specific permission by id' })
  @ApiResponse({ status: 200, description: 'Return the permission.' })
  @ApiResponse({ status: 404, description: 'Permission not found.' })
  @RequirePermissions('permissions_read')
  @Get(':id')
  findOne(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.permissionsService.findOne(id);
  }

  @ApiOperation({ summary: 'Fully update a specific permission' })
  @ApiResponse({ status: 200, description: 'The permission has been successfully updated.' })
  @ApiResponse({ status: 404, description: 'Permission not found.' })
  @ApiResponse({ status: 409, description: 'Permission slug already exists.' })
  @RequirePermissions('permissions_update')
  @Put(':id')
  @Throttle({ default: sensitiveThrottleConfig })
  update(@Param('id', new ParseUUIDPipe()) id: string, @Body() updatePermissionDto: UpdatePermissionDto) {
    return this.permissionsService.update(id, updatePermissionDto);
  }

  @ApiOperation({ summary: 'Restore a soft-deleted permission' })
  @ApiResponse({ status: 200, description: 'The permission has been successfully restored.' })
  @ApiResponse({ status: 404, description: 'Permission not found.' })
  @ApiResponse({ status: 409, description: 'Permission is already active.' })
  @RequirePermissions('permissions_update')
  @Patch(':id/restore')
  @Throttle({ default: sensitiveThrottleConfig })
  restore(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.permissionsService.restore(id);
  }

  @ApiOperation({ summary: 'Soft delete a permission' })
  @ApiResponse({ status: 200, description: 'The permission has been successfully soft deleted.' })
  @ApiResponse({ status: 404, description: 'Permission not found.' })
  @ApiResponse({ status: 409, description: 'Permission is already soft deleted.' })
  @RequirePermissions('permissions_delete')
  @Delete(':id/soft')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: sensitiveThrottleConfig })
  softRemove(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.permissionsService.softRemove(id);
  }

  @ApiOperation({ summary: 'Hard delete a permission' })
  @ApiResponse({ status: 200, description: 'The permission has been permanently deleted.' })
  @ApiResponse({ status: 404, description: 'Permission not found.' })
  @RequirePermissions('permissions_delete')
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: sensitiveThrottleConfig })
  hardRemove(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.permissionsService.hardRemove(id);
  }
}
