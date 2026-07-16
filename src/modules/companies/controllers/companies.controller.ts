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
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ApiPaginationQuery } from '../../../common/decorators/api-pagination-query.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { JwtPayload } from '../../../common/guards/jwt-auth.guard';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import { resolveSensitiveThrottleConfig } from '../../../config/throttler.config';
import { CreateCompanyDto } from '../dto/create-company.dto';
import { UpdateCompanyDto } from '../dto/update-company.dto';
import { CompaniesService } from '../services/companies.service';

const sensitiveThrottleConfig = resolveSensitiveThrottleConfig();

@ApiTags('Companies')
@ApiBearerAuth('bearer')
@Controller({ path: 'companies', version: '1' })
export class CompaniesController {
  constructor(private readonly companiesService: CompaniesService) {}

  @ApiOperation({ summary: 'Create a new company. Owner is automatically set from the authenticated user.' })
  @ApiResponse({ status: 201, description: 'The company has been successfully created.' })
  @ApiResponse({ status: 409, description: 'The user already owns a company.' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: CreateCompanyDto })
  @RequirePermissions('company_create')
  @Post()
  @UseInterceptors(FileInterceptor('logo', {
    dest: './uploads/company-logos',
    fileFilter: (req, file, cb) => {
      if (!file.mimetype.startsWith('image/')) {
        return cb(new Error('Only image files are allowed!'), false);
      }
      cb(null, true);
    },
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  }))
  @Throttle({ default: sensitiveThrottleConfig })
  create(@Body() createCompanyDto: CreateCompanyDto, @UploadedFile() file: any, @CurrentUser() user: JwtPayload) {
    // Set ownerId from current user JWT token
    createCompanyDto['ownerId'] = user.userId;
    if (file) {
      createCompanyDto.logo = file.path.replace(/\\/g, '/');
    }
    return this.companiesService.create(createCompanyDto);
  }

  @ApiOperation({ summary: 'Get all companies' })
  @ApiResponse({ status: 200, description: 'Return all companies.' })
  @RequirePermissions('company_read')
  @Get()
  @ApiPaginationQuery()
  findAll(@Query() query: PaginationDto) {
    return this.companiesService.findAll(query);
  }

  @ApiOperation({ summary: 'Get a specific company by id' })
  @ApiResponse({ status: 200, description: 'Return the company.' })
  @ApiResponse({ status: 404, description: 'Company not found.' })
  @RequirePermissions('company_read')
  @Get(':id')
  findOne(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.companiesService.findOne(id);
  }

  @ApiOperation({ summary: 'Fully update a specific company' })
  @ApiResponse({ status: 200, description: 'The company has been successfully updated.' })
  @ApiResponse({ status: 404, description: 'Company not found.' })
  @ApiResponse({ status: 409, description: 'The user already owns a company.' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: UpdateCompanyDto })
  @RequirePermissions('company_update')
  @Put(':id')
  @UseInterceptors(FileInterceptor('logo', {
    dest: './uploads/company-logos',
    fileFilter: (req, file, cb) => {
      if (!file.mimetype.startsWith('image/')) {
        return cb(new Error('Only image files are allowed!'), false);
      }
      cb(null, true);
    },
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  }))
  @Throttle({ default: sensitiveThrottleConfig })
  update(@Param('id', new ParseUUIDPipe()) id: string, @Body() updateCompanyDto: UpdateCompanyDto, @UploadedFile() file: any) {
    if (file) {
      updateCompanyDto.logo = file.path.replace(/\\/g, '/');
    }
    return this.companiesService.update(id, updateCompanyDto);
  }

  @ApiOperation({ summary: 'Restore a soft-deleted company' })
  @ApiResponse({ status: 200, description: 'The company has been successfully restored.' })
  @ApiResponse({ status: 404, description: 'Company not found.' })
  @ApiResponse({ status: 409, description: 'Company is already active.' })
  @RequirePermissions('company_update')
  @Patch(':id/restore')
  @Throttle({ default: sensitiveThrottleConfig })
  restore(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.companiesService.restore(id);
  }

  @ApiOperation({ summary: 'Soft delete a company' })
  @ApiResponse({ status: 200, description: 'The company has been successfully soft deleted.' })
  @ApiResponse({ status: 404, description: 'Company not found.' })
  @ApiResponse({ status: 409, description: 'Company is already soft deleted.' })
  @RequirePermissions('company_delete')
  @Delete(':id/soft')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: sensitiveThrottleConfig })
  softRemove(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.companiesService.softRemove(id);
  }

  @ApiOperation({ summary: 'Hard delete a company' })
  @ApiResponse({ status: 200, description: 'The company has been permanently deleted.' })
  @ApiResponse({ status: 404, description: 'Company not found.' })
  @RequirePermissions('company_delete')
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: sensitiveThrottleConfig })
  hardRemove(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.companiesService.hardRemove(id);
  }
}
