import { validationError } from './errors.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Emails are unique ignoring case, so they are stored trimmed and lower-cased. */
export function normalizeEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
    throw validationError('Datos inválidos', [
      { field: 'email', message: 'El correo electrónico no es válido' },
    ]);
  }
  return email;
}
