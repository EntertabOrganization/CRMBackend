import { Inject, Injectable, Logger } from '@nestjs/common';
import { Company, Prisma } from '@prisma/client';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import { PaginatedResult } from '../../../common/interfaces/paginated-result.interface';
import { buildPaginatedResult, buildPaginationParams, buildWhereWithSoftDelete } from '../../../common/utils/pagination.util';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { COMPANIES_REPOSITORY } from '../constants/companies.tokens';
import { CreateCompanyDto } from '../dto/create-company.dto';
import { UpdateCompanyDto } from '../dto/update-company.dto';
import {
  CompanyAlreadyActiveException,
  CompanyAlreadyDeletedException,
  CompanyNotFoundException,
  CompanyOwnerNotFoundException,
  CompaniesSchemaOutdatedException,
  UserAlreadyHasCompanyException,
} from '../exceptions/company.exceptions';
import { CompaniesRepository } from '../interfaces/companies-repository.interface';
import { CompaniesCacheService } from './companies-cache.service';

@Injectable()
export class CompaniesService {
  private readonly logger = new Logger(CompaniesService.name);

  constructor(
    @Inject(COMPANIES_REPOSITORY)
    private readonly companiesRepository: CompaniesRepository,
    private readonly companiesCacheService: CompaniesCacheService,
    private readonly prisma: PrismaService,
  ) {}

  async create(createCompanyDto: CreateCompanyDto): Promise<Company> {
    try {
      // ownerId is now always required and comes from JWT token
      const ownerId = createCompanyDto['ownerId'] || createCompanyDto.ownerId;
      if (!ownerId) {
        throw new Error('Owner ID is required. Company creation requires authentication.');
      }

      await this.ensureOwnerExists(ownerId);
      await this.ensureOwnerAvailable(ownerId);

      const company = await this.prisma.$transaction(
        async (tx) => {
          // 1. Create the company
          const createdCompany = await tx.company.create({
            data: {
              ...createCompanyDto,
              ownerId,
              isDeleted: false,
            } as Prisma.CompanyUncheckedCreateInput,
          });

          // 2. Fetch all system permissions
          const permissions = await tx.permission.findMany({
            where: { isDeleted: false },
            select: { id: true },
          });

          // 3. Create 'admin' role for this company with all permissions
          const adminRole = await tx.role.create({
            data: {
              name: 'admin',
              description: 'Company Administrator with full access.',
              companyId: createdCompany.id,
              isDeleted: false,
              permissions: {
                create: permissions.map((p) => ({
                  isDeleted: false,
                  permission: { connect: { id: p.id } },
                })),
              },
            },
          });

          // 4. Update the user's companyId and ensure they have only the admin role
          // First, delete existing roles for this user (like NoCompanyRole)
          await tx.userRole.deleteMany({
            where: { userId: ownerId },
          });

          // Assign the new admin role
          await tx.userRole.create({
            data: {
              userId: ownerId,
              roleId: adminRole.id,
              isDeleted: false,
            },
          });

          // Update the user's company link
          await tx.user.update({
            where: { id: ownerId },
            data: { companyId: createdCompany.id },
          });

          // 5. Default pipeline creation removed - Pipeline model not in use

          return createdCompany;
        },
        {
          timeout: 15000, // 15 seconds - increased from default 5 seconds
        },
      );

      this.companiesCacheService.invalidateCompany(company.id);
      this.companiesCacheService.setCompany(company);
      return company;
    } catch (error) {
      this.logger.error('Error creating company', error instanceof Error ? error.stack : String(error));
      throw this.mapPersistenceError(error, createCompanyDto['ownerId'] || createCompanyDto.ownerId);
    }
  }

  async findAll(paginationDto: PaginationDto): Promise<PaginatedResult<Company>> {
    const where = buildWhereWithSoftDelete(paginationDto.filters, paginationDto.is_deleted);
    const pagination = buildPaginationParams(paginationDto, 'name');
    const cacheKey = JSON.stringify({
      where,
      pagination,
      page: paginationDto.page,
      limit: paginationDto.limit,
      sortOrder: paginationDto.sortOrder,
    });

    const cachedCompanies = this.companiesCacheService.getCollection<PaginatedResult<Company>>(cacheKey);
    if (cachedCompanies) {
      return cachedCompanies;
    }

    const [data, total] = await Promise.all([
      this.companiesRepository.findMany({
        where,
        ...pagination,
      }),
      this.companiesRepository.count(where),
    ]);

    const result = buildPaginatedResult(data, total, paginationDto);
    this.companiesCacheService.setCollection(cacheKey, result);
    return result;
  }

  async findOne(id: string): Promise<Company> {
    const cachedCompany = this.companiesCacheService.getCompany(id);
    if (cachedCompany) {
      return cachedCompany;
    }

    const company = await this.getCompanyOrThrow(id);
    this.companiesCacheService.setCompany(company);
    return company;
  }

  async update(id: string, updateCompanyDto: UpdateCompanyDto): Promise<Company> {
    try {
      const company = await this.getCompanyOrThrow(id);
      const existingOwnerId = (company as Company & { ownerId?: string | null }).ownerId;

      if (updateCompanyDto.ownerId && updateCompanyDto.ownerId !== existingOwnerId) {
        await this.ensureOwnerExists(updateCompanyDto.ownerId);
        await this.ensureOwnerAvailable(updateCompanyDto.ownerId);
      }

      const updatedCompany = await this.companiesRepository.update({ id }, updateCompanyDto);
      this.companiesCacheService.invalidateCompany(id);
      this.companiesCacheService.setCompany(updatedCompany);
      return updatedCompany;
    } catch (error) {
      this.logger.error(`Error updating company with id ${id}`, error instanceof Error ? error.stack : String(error));
      throw this.mapPersistenceError(error, updateCompanyDto.ownerId);
    }
  }

  async softRemove(id: string): Promise<Company> {
    try {
      const company = await this.getCompanyIncludingDeletedOrThrow(id);

      if (company.isDeleted) {
        throw new CompanyAlreadyDeletedException(id);
      }

      const deletedCompany = await this.companiesRepository.update({ id }, {
        isDeleted: true,
      });
      this.companiesCacheService.invalidateCompany(id);
      return deletedCompany;
    } catch (error) {
      this.logger.error(`Error soft deleting company with id ${id}`, error instanceof Error ? error.stack : String(error));
      throw error;
    }
  }

  async hardRemove(id: string): Promise<Company> {
    try {
      await this.getCompanyIncludingDeletedOrThrow(id);
      const deletedCompany = await this.companiesRepository.delete({ id });
      this.companiesCacheService.invalidateCompany(id);
      return deletedCompany;
    } catch (error) {
      this.logger.error(`Error hard deleting company with id ${id}`, error instanceof Error ? error.stack : String(error));
      throw error;
    }
  }

  async restore(id: string): Promise<Company> {
    try {
      const company = await this.getCompanyIncludingDeletedOrThrow(id);

      if (!company.isDeleted) {
        throw new CompanyAlreadyActiveException(id);
      }

      const restoredCompany = await this.companiesRepository.update({ id }, {
        isDeleted: false,
      });
      this.companiesCacheService.invalidateCompany(id);
      this.companiesCacheService.setCompany(restoredCompany);
      return restoredCompany;
    } catch (error) {
      this.logger.error(`Error restoring company with id ${id}`, error instanceof Error ? error.stack : String(error));
      throw error;
    }
  }

  private async getCompanyOrThrow(id: string): Promise<Company> {
    const company = await this.companiesRepository.findById(id);

    if (!company) {
      throw new CompanyNotFoundException(id);
    }

    return company;
  }

  private async getCompanyIncludingDeletedOrThrow(id: string): Promise<Company> {
    const company = await this.companiesRepository.findById(id, { includeDeleted: true });

    if (!company) {
      throw new CompanyNotFoundException(id);
    }

    return company;
  }

  private async ensureOwnerAvailable(ownerId: string): Promise<void> {
    const existingCompany = await this.companiesRepository.findByOwnerId(ownerId, { includeDeleted: true });

    if (existingCompany) {
      throw new UserAlreadyHasCompanyException(ownerId);
    }
  }

  private async ensureOwnerExists(ownerId: string): Promise<void> {
    const owner = await this.prisma.user.findFirst({
      where: {
        id: ownerId,
        isDeleted: false,
      },
      select: {
        id: true,
      },
    });

    if (!owner) {
      throw new CompanyOwnerNotFoundException(ownerId);
    }
  }

  private mapPersistenceError(error: unknown, ownerId?: string): unknown {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
      return error;
    }

    if (error.code === 'P2002') {
      return new UserAlreadyHasCompanyException(ownerId ?? 'unknown');
    }

    if (error.code === 'P2003' && ownerId) {
      return new CompanyOwnerNotFoundException(ownerId);
    }

    if (error.code === 'P2022') {
      return new CompaniesSchemaOutdatedException();
    }

    return error;
  }
}
