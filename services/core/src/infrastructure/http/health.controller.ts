import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { CheckHealthUseCase } from '../../application/health/check-health.use-case.js';
import { isHealthy, type HealthStatus } from '../../domain/health/health-status.js';
import { Public } from './auth-decorators.js';
import { CHECK_HEALTH_USE_CASE } from './tokens.js';

@Controller('health')
export class HealthController {
  constructor(@Inject(CHECK_HEALTH_USE_CASE) private readonly checkHealth: CheckHealthUseCase) {}

  @Public()
  @Get()
  async get(@Res({ passthrough: true }) reply: FastifyReply): Promise<HealthStatus> {
    const status = await this.checkHealth.execute();
    if (!isHealthy(status)) {
      reply.status(503);
    }
    return status;
  }
}
