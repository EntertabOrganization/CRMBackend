import { ConflictException, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { COMPANY_ERRORS } from '../errors/company.errors';

export class CompanyNotFoundException extends NotFoundException {
  constructor(id: string) {
    super(COMPANY_ERRORS.NOT_FOUND(id));
  }
}

export class UserAlreadyHasCompanyException extends ConflictException {
  constructor(ownerId: string) {
    super(COMPANY_ERRORS.USER_ALREADY_HAS_COMPANY(ownerId));
  }
}

export class CompanyOwnerNotFoundException extends NotFoundException {
  constructor(ownerId: string) {
    super(COMPANY_ERRORS.OWNER_NOT_FOUND(ownerId));
  }
}

export class CompanyAlreadyDeletedException extends ConflictException {
  constructor(id: string) {
    super(COMPANY_ERRORS.ALREADY_DELETED(id));
  }
}

export class CompanyAlreadyActiveException extends ConflictException {
  constructor(id: string) {
    super(COMPANY_ERRORS.ALREADY_ACTIVE(id));
  }
}

export class CompaniesSchemaOutdatedException extends InternalServerErrorException {
  constructor() {
    super(COMPANY_ERRORS.SCHEMA_OUTDATED);
  }
}
