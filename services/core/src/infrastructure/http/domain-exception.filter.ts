import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { DomainError, type ErrorKind } from '../../domain/shared/errors.js';

const STATUS: Record<ErrorKind, number> = {
  validation: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
};

const REASON: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  500: 'Internal Server Error',
};

const GENERIC_MESSAGE: Record<number, string> = {
  400: 'Solicitud inválida',
  404: 'Recurso no encontrado',
  405: 'Método no permitido',
  413: 'La solicitud es demasiado grande',
  415: 'Tipo de contenido no soportado',
};

/** Uniform error body: { statusCode, error, code?, message, details? }. Internals are never exposed. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('http');

  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    let statusCode = 500;
    let body: Record<string, unknown>;

    if (exception instanceof DomainError) {
      statusCode = STATUS[exception.kind];
      body = {
        code: exception.code,
        message: exception.message,
        ...(exception.details ? { details: exception.details } : {}),
        ...exception.extra,
      };
    } else {
      const status = this.clientStatus(exception);
      if (status) {
        statusCode = status;
        body = { message: GENERIC_MESSAGE[status] ?? 'Solicitud inválida' };
      } else {
        // Unexpected error (e.g. database): log the details, answer generically.
        this.logger.error(
          exception instanceof Error ? (exception.stack ?? exception.message) : String(exception),
        );
        body = { message: 'Error interno del servidor' };
      }
    }
    void reply
      .status(statusCode)
      .send({ statusCode, error: REASON[statusCode] ?? 'Error', ...body });
  }

  private clientStatus(exception: unknown): number | null {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return status >= 400 && status < 500 ? status : null;
    }
    const status = (exception as { statusCode?: unknown } | null)?.statusCode;
    return typeof status === 'number' && status >= 400 && status < 500 ? status : null;
  }
}
