import { generateKeyPairSync } from 'node:crypto';
import { SignJWT, importPKCS8 } from 'jose';
import { describe, expect, it } from 'vitest';
import { ACCESS_TOKEN_ISSUER, InvalidAccessTokenError, verifyAccessToken } from './access-token.js';
import { hasAllPermissions } from './permissions.js';

function pair() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }) as string,
  };
}

async function sign(privatePem: string, exp: string) {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256' })
    .setSubject('user-1')
    .setIssuer(ACCESS_TOKEN_ISSUER)
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(await importPKCS8(privatePem, 'ES256'));
}

describe('verifyAccessToken', () => {
  it('accepts a valid token', async () => {
    const keys = pair();
    const claims = await verifyAccessToken(await sign(keys.privatePem, '5m'), keys.publicPem);
    expect(claims.userId).toBe('user-1');
  });

  it('rejects tokens signed with another key, tampered or expired', async () => {
    const keys = pair();
    const other = pair();
    const token = await sign(keys.privatePem, '5m');
    await expect(
      verifyAccessToken(await sign(other.privatePem, '5m'), keys.publicPem),
    ).rejects.toBeInstanceOf(InvalidAccessTokenError);
    await expect(
      verifyAccessToken(token.slice(0, -4) + 'AAAA', keys.publicPem),
    ).rejects.toBeInstanceOf(InvalidAccessTokenError);
    await expect(
      verifyAccessToken(await sign(keys.privatePem, '-1m'), keys.publicPem),
    ).rejects.toBeInstanceOf(InvalidAccessTokenError);
    await expect(verifyAccessToken('garbage', keys.publicPem)).rejects.toBeInstanceOf(
      InvalidAccessTokenError,
    );
  });
});

describe('hasAllPermissions', () => {
  it('requires every permission', () => {
    expect(hasAllPermissions(['a.b', 'c.d'], ['a.b'])).toBe(true);
    expect(hasAllPermissions(['a.b'], ['a.b', 'c.d'])).toBe(false);
    expect(hasAllPermissions([], [])).toBe(true);
  });
});
