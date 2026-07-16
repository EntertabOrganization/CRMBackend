import { ConflictException, NotFoundException } from '@nestjs/common';
import { PERMISSION_ERRORS } from '../errors/permission.errors';

export class PermissionNotFoundException extends NotFoundException {
  constructor(id: string) {
    super(PERMISSION_ERRORS.NOT_FOUND(id));
  }
}

export class PermissionAlreadyExistsException extends ConflictException {
  constructor(slug: string) {
    super(PERMISSION_ERRORS.ALREADY_EXISTS(slug));
  }
}

export class PermissionSoftDeletedConflictException extends ConflictException {
  constructor(slug: string) {
    super(PERMISSION_ERRORS.SOFT_DELETED(slug));
  }
}

export class PermissionAlreadyDeletedException extends ConflictException {
  constructor(id: string) {
    super(PERMISSION_ERRORS.ALREADY_DELETED(id));
  }
}

export class PermissionAlreadyActiveException extends ConflictException {
  constructor(id: string) {
    super(PERMISSION_ERRORS.ALREADY_ACTIVE(id));
  }
}
