export class AppError extends Error {
  readonly isAppError = true as const;
  readonly code: string;
  readonly status: number;
  readonly details: unknown;

  constructor(code: string, message: string, status = 400, details: unknown = null) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

// Next.js dev compiles each route handler as its own bundle, which can give a shared
// module like this one more than one live instance — `instanceof AppError` then fails
// across that boundary even though the thrown object is shaped exactly like one. Check
// the marker property instead of the prototype chain so error handling doesn't depend
// on which copy of this class constructed the error.
export function isAppError(error: unknown): error is AppError {
  return typeof error === 'object' && error !== null && (error as { isAppError?: unknown }).isAppError === true;
}

export const badRequest = (code: string, message: string, details: unknown = null) =>
  new AppError(code, message, 400, details);

export const unauthorized = (message = 'Authentication is required.') =>
  new AppError('UNAUTHENTICATED', message, 401);

export const forbidden = (message = 'Permission denied.') =>
  new AppError('PERMISSION_DENIED', message, 403);

export const notFound = (entity = 'Resource') =>
  new AppError('NOT_FOUND', `${entity} was not found.`, 404);

export const conflict = (code: string, message: string, details: unknown = null) =>
  new AppError(code, message, 409, details);

export const tooManyRequests = (message = 'Too many requests. Please try again later.') =>
  new AppError('RATE_LIMITED', message, 429);

export const fieldValidationFailed = (fields: Record<string, { code: string; message: string; requirementRuleIds?: string[] }[]>) =>
  new AppError('FIELD_VALIDATION_FAILED', 'One or more fields are invalid.', 400, { fields });
