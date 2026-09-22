import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { DomainError } from '../auth-module';

type HttpReply = { status: (code: number) => { send: (body: unknown) => void } };

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<HttpReply>();
    const request = host.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>();
    const requestId = request.headers['x-request-id'] ?? 'request-id';

    if (exception instanceof DomainError) {
      response.status(statusFor(exception.code)).send({
        success: false,
        error: { code: exception.code, message: exception.message, details: exception.details },
        requestId,
      });
      return;
    }

    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).send({
        success: false,
        error: { code: 'HTTP_ERROR', message: exception.message, details: exception.getResponse() },
        requestId,
      });
      return;
    }

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error.', details: null },
      requestId,
    });
  }
}

function statusFor(code: string): number {
  if (code === 'RATE_LIMITED') return 429;
  if (code === 'UNAUTHENTICATED' || code === 'INVALID_CREDENTIALS' || code.includes('TOKEN')) return 401;
  if (code === 'PERMISSION_DENIED') return 403;
  if (code.includes('NOT_FOUND')) return 404;
  if (code.includes('DUPLICATE') || code.includes('EXISTS') || code.includes('IN_USE') || code.includes('REQUIRED') || code.includes('WEAK') || code.includes('PROTECTED')) return 409;
  return 400;
}
