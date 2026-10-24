import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { isHealthy, type HealthStatus } from '../../domain/health/health-status.js';
import { Public } from './auth-decorators.js';
import type { UseCases } from './composition.js';
import { USE_CASES } from './tokens.js';

@Controller('health')
export class HealthController {
  constructor(@Inject(USE_CASES) private readonly uc: UseCases) {}

  @Public()
  @Get()
  async get(@Res({ passthrough: true }) reply: FastifyReply): Promise<HealthStatus> {
    const status = await this.uc.health.execute();
    if (!isHealthy(status)) {
      reply.status(503);
    }
    return status;
  }
}
