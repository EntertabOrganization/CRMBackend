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
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ApiPaginationQuery } from '../../../common/decorators/api-pagination-query.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { JwtPayload } from '../../../common/guards/jwt-auth.guard';
import { resolveSensitiveThrottleConfig } from '../../../config/throttler.config';
import { CreateRoleDto } from '../dto/create-role.dto';
import { RolesPaginationDto } from '../dto/roles-pagination.dto';
import { UpdateRoleDto } from '../dto/update-role.dto';
import { RolesService } from '../services/roles.service';

const sensitiveThrottleConfig = resolveSensitiveThrottleConfig();

@ApiTags('Roles')
@ApiBearerAuth('bearer')
@Controller({ path: 'roles', version: '1' })
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @RequirePermissions('roles_create')
  @Post()
  @Throttle({ default: sensitiveThrottleConfig })
  create(@Body() createRoleDto: CreateRoleDto, @CurrentUser() user: JwtPayload) {
    createRoleDto.companyId = user.companyId;
    return this.rolesService.create(createRoleDto);
  }

  @RequirePermissions('roles_read')
  @Get()
  @ApiPaginationQuery()
  findAll(@Query() query: RolesPaginationDto, @CurrentUser() user: JwtPayload) {
    query.companyId = user.companyId;
    return this.rolesService.findAll(query);
  }

  @ApiResponse({ status: 404, description: 'Role not found.' })
  @RequirePermissions('roles_read')
  @Get(':id')
  findOne(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.rolesService.findOne(id, user.companyId);
  }

  @ApiResponse({ status: 409, description: 'Role name already exists within the company.' })
  @RequirePermissions('roles_update')
  @Put(':id')
  @Throttle({ default: sensitiveThrottleConfig })
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() updateRoleDto: UpdateRoleDto,
    @CurrentUser() user: JwtPayload,
  ) {
    updateRoleDto.companyId = user.companyId;
    return this.rolesService.update(id, user.companyId, updateRoleDto);
  }

  @ApiResponse({ status: 409, description: 'Role is already active.' })
  @RequirePermissions('roles_update')
  @Patch(':id/restore')
  @Throttle({ default: sensitiveThrottleConfig })
  restore(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.rolesService.restore(id, user.companyId);
  }

  @ApiResponse({ status: 409, description: 'Role is already soft deleted.' })
  @RequirePermissions('roles_delete')
  @Delete(':id/soft')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: sensitiveThrottleConfig })
  softRemove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.rolesService.softRemove(id, user.companyId);
  }

  @ApiResponse({ status: 404, description: 'Role not found.' })
  @RequirePermissions('roles_delete')
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: sensitiveThrottleConfig })
  hardRemove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.rolesService.hardRemove(id, user.companyId);
  }
}
