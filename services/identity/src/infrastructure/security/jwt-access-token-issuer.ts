import { randomUUID } from 'node:crypto';
import { importPKCS8, SignJWT, type CryptoKey } from 'jose';
import { ACCESS_TOKEN_ALGORITHM, ACCESS_TOKEN_ISSUER } from '@inventory/shared';
import type { AccessTokenIssuer, IssuedAccessToken } from '../../domain/auth/ports.js';

/** Signs short-lived access tokens with ES256 (private key); verifiers only need the public key. */
export class JwtAccessTokenIssuer implements AccessTokenIssuer {
  private key: Promise<CryptoKey> | undefined;

  constructor(
    private readonly privateKeyPem: string,
    private readonly ttlSeconds: number,
  ) {}

  async issue(userId: string): Promise<IssuedAccessToken> {
    this.key ??= importPKCS8(this.privateKeyPem, ACCESS_TOKEN_ALGORITHM);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: ACCESS_TOKEN_ALGORITHM, typ: 'JWT' })
      .setSubject(userId)
      .setIssuer(ACCESS_TOKEN_ISSUER)
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime(`${this.ttlSeconds}s`)
      .sign(await this.key);
    return { token, expiresIn: this.ttlSeconds };
  }
}
