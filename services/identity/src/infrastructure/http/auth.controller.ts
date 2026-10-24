import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { CurrentUserId, Public } from './auth-decorators.js';
import type { UseCases } from './composition.js';
import { changePasswordSchema, loginSchema, refreshSchema } from './schemas.js';
import { USE_CASES } from './tokens.js';
import { ZodValidationPipe } from './zod-validation.pipe.js';

@Controller('auth')
export class AuthController {
  constructor(@Inject(USE_CASES) private readonly uc: UseCases) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body(new ZodValidationPipe(loginSchema)) body: { email: string; password: string }) {
    return this.uc.login.execute(body);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body(new ZodValidationPipe(refreshSchema)) body: { refreshToken: string }) {
    return this.uc.refresh.execute(body.refreshToken);
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Body(new ZodValidationPipe(refreshSchema)) body: { refreshToken: string }) {
    await this.uc.logout.execute(body.refreshToken);
  }

  @Get('me')
  me(@CurrentUserId() userId: string) {
    return this.uc.me.execute(userId);
  }

  @Post('change-password')
  @HttpCode(204)
  async changePassword(
    @CurrentUserId() userId: string,
    @Body(new ZodValidationPipe(changePasswordSchema))
    body: { currentPassword: string; newPassword: string },
  ) {
    await this.uc.changePassword.execute(userId, body);
  }
}
