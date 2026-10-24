import { createHash, randomBytes } from 'node:crypto';
import type { RefreshTokenCodec } from '../../domain/auth/ports.js';

export class RandomRefreshTokenCodec implements RefreshTokenCodec {
  generate(): { token: string; hash: string } {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: this.hash(token) };
  }

  hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
