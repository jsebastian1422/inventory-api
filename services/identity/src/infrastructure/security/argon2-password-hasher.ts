import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import type { PasswordHasher } from '../../domain/auth/ports.js';

export class Argon2PasswordHasher implements PasswordHasher {
  private dummyHash: Promise<string> | undefined;

  hash(plain: string): Promise<string> {
    return argon2.hash(plain, { type: argon2.argon2id });
  }

  async verify(hash: string | null, plain: string): Promise<boolean> {
    try {
      // Unknown user: verify against a throwaway hash so timing does not reveal existence.
      const target = hash ?? (await this.getDummyHash());
      const ok = await argon2.verify(target, plain);
      return hash !== null && ok;
    } catch {
      return false;
    }
  }

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= this.hash(randomBytes(16).toString('hex'));
    return this.dummyHash;
  }
}
