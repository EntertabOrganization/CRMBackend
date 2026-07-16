import { ConflictException, ForbiddenException, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { ROLE_ERRORS } from '../errors/role.errors';

export class RoleNotFoundException extends NotFoundException {
  constructor(id: string) {
    super(ROLE_ERRORS.NOT_FOUND(id));
  }
}

export class RoleAlreadyExistsException extends ConflictException {
  constructor(name: string, companyId: string) {
    super(ROLE_ERRORS.ALREADY_EXISTS(name, companyId));
  }
}

export class RoleAlreadyDeletedException extends ConflictException {
  constructor(id: string) {
    super(ROLE_ERRORS.ALREADY_DELETED(id));
  }
}

export class RoleAlreadyActiveException extends ConflictException {
  constructor(id: string) {
    super(ROLE_ERRORS.ALREADY_ACTIVE(id));
  }
}

export class RoleUnauthorizedCompanyScopeException extends ForbiddenException {
  constructor(id: string, companyId: string) {
    super(ROLE_ERRORS.UNAUTHORIZED_COMPANY_SCOPE(id, companyId));
  }
}

export class RolePermissionsNotFoundException extends NotFoundException {
  constructor() {
    super(ROLE_ERRORS.PERMISSIONS_NOT_FOUND);
  }
}

export class RolesSchemaOutdatedException extends InternalServerErrorException {
  constructor() {
    super(ROLE_ERRORS.SCHEMA_OUTDATED);
  }
}
