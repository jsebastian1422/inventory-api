import { importSPKI, jwtVerify, type CryptoKey } from 'jose';

export const ACCESS_TOKEN_ALGORITHM = 'ES256';
export const ACCESS_TOKEN_ISSUER = 'inventory-identity';

/** Claims carried by an access token. Permissions are NOT in the token: they are read live. */
export interface AccessTokenClaims {
  readonly userId: string;
  readonly expiresAt: Date;
}

export class InvalidAccessTokenError extends Error {}

const keyCache = new Map<string, Promise<CryptoKey>>();

function publicKey(pem: string): Promise<CryptoKey> {
  let key = keyCache.get(pem);
  if (!key) {
    key = importSPKI(pem, ACCESS_TOKEN_ALGORITHM);
    keyCache.set(pem, key);
  }
  return key;
}

/**
 * Verifies signature (ES256), issuer and expiry of an access token using only the public key (PEM).
 * Framework-agnostic: any service can use it. Throws InvalidAccessTokenError on any failure.
 */
export async function verifyAccessToken(
  token: string,
  publicKeyPem: string,
): Promise<AccessTokenClaims> {
  try {
    const key = await publicKey(publicKeyPem);
    const { payload } = await jwtVerify(token, key, {
      algorithms: [ACCESS_TOKEN_ALGORITHM],
      issuer: ACCESS_TOKEN_ISSUER,
    });
    if (typeof payload.sub !== 'string' || typeof payload.exp !== 'number') {
      throw new InvalidAccessTokenError('Malformed access token');
    }
    return { userId: payload.sub, expiresAt: new Date(payload.exp * 1000) };
  } catch (error) {
    if (error instanceof InvalidAccessTokenError) throw error;
    throw new InvalidAccessTokenError('Invalid or expired access token');
  }
}
