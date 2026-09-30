import { AppError } from '@/src/server/errors';
import { translateDatabaseError } from '@/src/server/response';

describe('database infrastructure errors', () => {
  it.each(['P1000', 'P1001', 'P1002', 'P1003', 'P1017'])('maps Prisma %s failures to a sanitized 503', (code) => {
    const translated = translateDatabaseError({ code, message: 'sensitive connection details' });
    expect(translated).toBeInstanceOf(AppError);
    expect(translated).toMatchObject({ code: 'DATABASE_UNAVAILABLE', status: 503, message: 'The database is temporarily unavailable.' });
    expect(JSON.stringify(translated)).not.toContain('sensitive connection details');
  });

  it('does not rewrite business errors', () => {
    const error = new AppError('VALIDATION_FAILED', 'Invalid input.', 400);
    expect(translateDatabaseError(error)).toBe(error);
  });
});
