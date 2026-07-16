import { ValidateBy, ValidationOptions, buildMessage } from 'class-validator';

export const isValidEmail = (email: string): boolean =>
  typeof email === 'string' &&
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

export const isValidPhoneNumber = (phone: string): boolean =>
  typeof phone === 'string' &&
  /^\+?[0-9()\-\s]{7,20}$/.test(phone.trim());

export const isValidString = (value: unknown): boolean =>
  typeof value === 'string' && value.trim().length > 0;

export const isValidNumber = (value: unknown): boolean =>
  typeof value === 'number' && Number.isFinite(value);

const buildValidator = (
  name: string,
  validator: (value: unknown) => boolean,
  defaultMessage: string,
  validationOptions?: ValidationOptions,
) =>
  ValidateBy(
    {
      name,
      validator: {
        validate: validator,
        defaultMessage: buildMessage(() => defaultMessage, validationOptions),
      },
    },
    validationOptions,
  );

export const IsValidEmail = (validationOptions?: ValidationOptions) =>
  buildValidator(
    'isValidEmail',
    (value) => isValidEmail(typeof value === 'string' ? value : ''),
    '$property must be a valid email address.',
    validationOptions,
  );

export const IsValidPhoneNumber = (validationOptions?: ValidationOptions) =>
  buildValidator(
    'isValidPhoneNumber',
    (value) => value === undefined || value === null || value === '' || isValidPhoneNumber(String(value)),
    '$property must be a valid phone number.',
    validationOptions,
  );

export const IsValidString = (validationOptions?: ValidationOptions) =>
  buildValidator('isValidString', isValidString, '$property must be a non-empty string.', validationOptions);

export const IsValidNumber = (validationOptions?: ValidationOptions) =>
  buildValidator('isValidNumber', isValidNumber, '$property must be a valid number.', validationOptions);
