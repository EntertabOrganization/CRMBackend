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
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ApiPaginationQuery } from '../../../common/decorators/api-pagination-query.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { JwtPayload } from '../../../common/guards/jwt-auth.guard';
import { resolveSensitiveThrottleConfig } from '../../../config/throttler.config';
import { CreateUserDto } from '../dto/create-user.dto';
import { UpdateUserDto } from '../dto/update-user.dto';
import { UsersPaginationDto } from '../dto/users-pagination.dto';
import { UsersService } from '../services/users.service';

const sensitiveThrottleConfig = resolveSensitiveThrottleConfig();

@ApiTags('Users')
@ApiBearerAuth('bearer')
@Controller({ path: 'users', version: '1' })
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @ApiOperation({ summary: 'Create a new user within a company scope or as unassigned' })
  @ApiResponse({ status: 201, description: 'The user has been successfully created.' })
  @ApiResponse({ status: 409, description: 'Email already exists.' })
  @ApiQuery({ name: 'companyId', required: false, type: String, format: 'uuid' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: CreateUserDto })
  @RequirePermissions('users_create')
  @Post()
  @UseInterceptors(FileInterceptor('profilePic', {
    dest: './uploads/profile-pics',
    fileFilter: (req, file, cb) => {
      if (!file.mimetype.startsWith('image/')) {
        return cb(new Error('Only image files are allowed!'), false);
      }
      cb(null, true);
    },
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  }))
  @Throttle({ default: sensitiveThrottleConfig })
  create(
    @Body() createUserDto: CreateUserDto,
    @UploadedFile() file: any,
    @CurrentUser() user: JwtPayload,
    @Query('companyId') companyId?: string,
  ) {
    if (file) {
      createUserDto.profilePic = file.path.replace(/\\/g, '/');
    }
    // Default to the user's own company if no companyId is provided in query
    const targetCompanyId = companyId || user.companyId;
    return this.usersService.create(createUserDto, targetCompanyId || undefined);
  }

  @ApiOperation({ summary: 'Get users by company scope or unassigned scope' })
  @ApiResponse({ status: 200, description: 'Return paginated users.' })
  @RequirePermissions('users_read')
  @Get()
  @ApiPaginationQuery()
  findAll(@Query() query: UsersPaginationDto, @CurrentUser() user: JwtPayload) {
    return this.usersService.findAll(query, user);
  }

  @ApiOperation({ summary: 'Get a user by id and company scope' })
  @ApiResponse({ status: 200, description: 'Return the user.' })
  @ApiResponse({ status: 403, description: 'User does not belong to the requested company scope.' })
  @ApiResponse({ status: 404, description: 'User not found.' })
  @ApiQuery({ name: 'companyId', required: false, type: String, format: 'uuid' })
  @RequirePermissions('users_read')
  @Get(':id')
  findOne(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.usersService.findOne(id, companyId);
  }

  @ApiOperation({ summary: 'Fully update a user by id and company scope' })
  @ApiResponse({ status: 200, description: 'The user has been successfully updated.' })
  @ApiResponse({ status: 403, description: 'User does not belong to the requested company scope.' })
  @ApiResponse({ status: 404, description: 'User not found.' })
  @ApiResponse({ status: 409, description: 'Email already exists.' })
  @ApiQuery({ name: 'companyId', required: false, type: String, format: 'uuid' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: UpdateUserDto })
  @RequirePermissions('users_update')
  @Put(':id')
  @UseInterceptors(FileInterceptor('profilePic', {
    dest: './uploads/profile-pics',
    fileFilter: (req, file, cb) => {
      if (!file.mimetype.startsWith('image/')) {
        return cb(new Error('Only image files are allowed!'), false);
      }
      cb(null, true);
    },
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  }))
  @Throttle({ default: sensitiveThrottleConfig })
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('companyId') companyId: string | undefined,
    @Body() updateUserDto: UpdateUserDto,
    @UploadedFile() file: any,
  ) {
    if (file) {
      updateUserDto.profilePic = file.path.replace(/\\/g, '/');
    }
    return this.usersService.update(id, companyId, updateUserDto);
  }

  @ApiOperation({ summary: 'Restore a soft-deleted user' })
  @ApiResponse({ status: 200, description: 'The user has been successfully restored.' })
  @ApiResponse({ status: 404, description: 'User not found.' })
  @ApiResponse({ status: 409, description: 'User is already active.' })
  @ApiQuery({ name: 'companyId', required: false, type: String, format: 'uuid' })
  @RequirePermissions('users_update')
  @Patch(':id/restore')
  @Throttle({ default: sensitiveThrottleConfig })
  restore(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.usersService.restore(id, companyId);
  }

  @ApiOperation({ summary: 'Soft delete a user' })
  @ApiResponse({ status: 200, description: 'The user has been successfully soft deleted.' })
  @ApiResponse({ status: 404, description: 'User not found.' })
  @ApiResponse({ status: 409, description: 'User is already soft deleted.' })
  @ApiQuery({ name: 'companyId', required: false, type: String, format: 'uuid' })
  @RequirePermissions('users_delete')
  @Delete(':id/soft')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: sensitiveThrottleConfig })
  softRemove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.usersService.softRemove(id, companyId);
  }

  @ApiOperation({ summary: 'Hard delete a user' })
  @ApiResponse({ status: 200, description: 'The user has been permanently deleted.' })
  @ApiResponse({ status: 404, description: 'User not found.' })
  @ApiQuery({ name: 'companyId', required: false, type: String, format: 'uuid' })
  @RequirePermissions('users_delete')
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: sensitiveThrottleConfig })
  hardRemove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.usersService.hardRemove(id, companyId);
  }
}
