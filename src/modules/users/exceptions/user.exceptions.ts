import {
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { USER_ERRORS } from '../errors/user.errors';

export class UserNotFoundException extends NotFoundException {
  constructor(id: string) {
    super(USER_ERRORS.NOT_FOUND(id));
  }
}

export class UserEmailAlreadyExistsException extends ConflictException {
  constructor(email: string) {
    super(USER_ERRORS.EMAIL_ALREADY_EXISTS(email));
  }
}

export class UserAlreadyDeletedException extends ConflictException {
  constructor(id: string) {
    super(USER_ERRORS.ALREADY_DELETED(id));
  }
}

export class UserAlreadyActiveException extends ConflictException {
  constructor(id: string) {
    super(USER_ERRORS.ALREADY_ACTIVE(id));
  }
}

export class UserUnauthorizedCompanyScopeException extends ForbiddenException {
  constructor(id: string, companyId?: string | null) {
    super(USER_ERRORS.UNAUTHORIZED_COMPANY_SCOPE(id, companyId ?? undefined));
  }
}

export class InvalidCredentialsException extends UnauthorizedException {
  constructor() {
    super(USER_ERRORS.INVALID_CREDENTIALS);
  }
}

export class RoleNotAssignedNotFoundException extends NotFoundException {
  constructor() {
    super(USER_ERRORS.ROLE_NOT_ASSIGNED_NOT_FOUND);
  }
}

export class UserRoleScopeInvalidException extends UnprocessableEntityException {
  constructor() {
    super(USER_ERRORS.ROLE_SCOPE_INVALID);
  }
}

export class SignupCompanyPayloadIncompleteException extends UnprocessableEntityException {
  constructor() {
    super(USER_ERRORS.COMPANY_PAYLOAD_INCOMPLETE);
  }
}

export class GoogleAuthNotImplementedException extends UnprocessableEntityException {
  constructor() {
    super(USER_ERRORS.GOOGLE_AUTH_NOT_IMPLEMENTED);
  }
}

export class UsersSchemaOutdatedException extends InternalServerErrorException {
  constructor() {
    super(USER_ERRORS.SCHEMA_OUTDATED);
  }
}

export class InvalidRefreshTokenException extends UnauthorizedException {
  constructor() {
    super('Invalid or expired refresh token');
  }
}
