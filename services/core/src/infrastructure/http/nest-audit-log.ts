import { Logger } from '@nestjs/common';
import type { AuditLog } from '../../domain/shared/audit-log.js';

const SENSITIVE_KEY = /pass|token|secret|hash|authorization/i;

/** Writes events as JSON lines. Defense in depth: sensitive-looking keys are never printed. */
export class NestAuditLog implements AuditLog {
  private readonly logger = new Logger('core');

  info(event: string, data: Record<string, unknown>): void {
    this.logger.log(this.format(event, data));
  }

  warn(event: string, data: Record<string, unknown>): void {
    this.logger.warn(this.format(event, data));
  }

  private format(event: string, data: Record<string, unknown>): string {
    const safe = Object.fromEntries(
      Object.entries(data).filter(([key]) => !SENSITIVE_KEY.test(key)),
    );
    return JSON.stringify({ event, ...safe });
  }
}
