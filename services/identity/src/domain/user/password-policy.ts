import { validationError } from '../shared/errors.js';

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

/** Policy: 8-128 characters, at least one letter and one number. */
export function assertPasswordPolicy(password: string, field = 'password'): void {
  const problems: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) {
    problems.push(`debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres`);
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    problems.push(`no puede superar ${PASSWORD_MAX_LENGTH} caracteres`);
  }
  if (!/\p{L}/u.test(password)) problems.push('debe incluir al menos una letra');
  if (!/\d/.test(password)) problems.push('debe incluir al menos un número');
  if (problems.length > 0) {
    throw validationError('Datos inválidos', [
      { field, message: `La contraseña ${problems.join(', ')}` },
    ]);
  }
}
