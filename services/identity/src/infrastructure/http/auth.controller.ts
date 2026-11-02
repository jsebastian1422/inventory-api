import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { TokenPair } from '../../application/auth/auth.use-cases.js';
import { PASSWORD_RESET_REQUESTED_MESSAGE } from '../../application/auth/password-reset.use-cases.js';
import { DomainError } from '../../domain/shared/errors.js';
import type { IdentityConfig } from '../config/config.js';
import { CurrentUserId, Public } from './auth-decorators.js';
import type { UseCases } from './composition.js';
import { CsrfGuard } from './csrf.guard.js';
import {
  changePasswordSchema,
  loginSchema,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
} from './schemas.js';
import {
  clearSessionCookie,
  readSessionCookie,
  setSessionCookie,
  type SessionCookieSettings,
} from './session-cookie.js';
import { APP_CONFIG, USE_CASES } from './tokens.js';
import { ZodValidationPipe } from './zod-validation.pipe.js';

/** Body of a session response: the refresh token travels only in the cookie (ADR-0007). */
type SessionBody = Omit<TokenPair, 'refreshToken'>;

@Controller('auth')
export class AuthController {
  private readonly cookie: SessionCookieSettings;

  constructor(
    @Inject(USE_CASES) private readonly uc: UseCases,
    @Inject(APP_CONFIG) config: IdentityConfig,
  ) {
    this.cookie = {
      secure: config.sessionCookieSecure,
      maxAgeSeconds: config.refreshTokenTtlSeconds,
    };
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodValidationPipe(loginSchema)) body: { email: string; password: string },
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SessionBody> {
    const pair = await this.uc.login.execute({ ...body, ip: request.ip });
    return this.startSession(reply, pair);
  }

  @Public()
  @UseGuards(CsrfGuard)
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SessionBody> {
    const token = readSessionCookie(request);
    try {
      return this.startSession(reply, await this.uc.refresh.execute(token ?? ''));
    } catch (error) {
      // An unusable session must not leave a dead cookie behind.
      if (error instanceof DomainError && error.kind === 'unauthorized') {
        clearSessionCookie(reply, this.cookie);
      }
      throw error;
    }
  }

  @Public()
  @UseGuards(CsrfGuard)
  @Post('logout')
  @HttpCode(204)
  async logout(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    await this.uc.logout.execute(readSessionCookie(request));
    clearSessionCookie(reply, this.cookie);
  }

  @Public()
  @Post('password-reset/request')
  @HttpCode(202)
  async requestPasswordReset(
    @Body(new ZodValidationPipe(passwordResetRequestSchema)) body: { email: string },
    @Req() request: FastifyRequest,
  ): Promise<{ message: string }> {
    await this.uc.requestPasswordReset.execute({ email: body.email, ip: request.ip });
    return { message: PASSWORD_RESET_REQUESTED_MESSAGE };
  }

  @Public()
  @Post('password-reset/confirm')
  @HttpCode(204)
  async confirmPasswordReset(
    @Body(new ZodValidationPipe(passwordResetConfirmSchema))
    body: {
      token: string;
      newPassword: string;
    },
  ): Promise<void> {
    await this.uc.confirmPasswordReset.execute(body);
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

  private startSession(reply: FastifyReply, pair: TokenPair): SessionBody {
    const { refreshToken, ...body } = pair;
    setSessionCookie(reply, refreshToken, this.cookie);
    return body;
  }
}
