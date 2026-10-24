import { type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { validationError, type FieldIssue } from '../../domain/shared/errors.js';

function messageFor(issue: z.core.$ZodIssue): string {
  if (issue.code === 'invalid_type') {
    return /received undefined/.test(issue.message) ? 'Campo obligatorio' : 'Tipo de dato inválido';
  }
  if (issue.code === 'too_small' || issue.code === 'too_big')
    return 'Valor o longitud fuera de rango';
  if (issue.code === 'invalid_format') return 'Formato inválido';
  return issue.message;
}

/** Validates a body/query/param with a zod schema; failures become a 400 with field details. */
export class ZodValidationPipe<S extends z.ZodType> implements PipeTransform<unknown, z.output<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.output<S> {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    const details: FieldIssue[] = result.error.issues.map((issue) => ({
      field: issue.path.join('.') || 'body',
      message: messageFor(issue),
    }));
    throw validationError('Datos inválidos', details);
  }
}
