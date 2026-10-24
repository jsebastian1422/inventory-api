// Generates a local ES256 (P-256) key pair for signing access tokens: keys/jwt-private.pem and
// keys/jwt-public.pem. Refuses to overwrite existing keys (that would invalidate all sessions)
// unless --force is passed. keys/ is git-ignored.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'keys');
const privatePath = join(dir, 'jwt-private.pem');
const publicPath = join(dir, 'jwt-public.pem');

if ((existsSync(privatePath) || existsSync(publicPath)) && !process.argv.includes('--force')) {
  console.error(
    'Ya existen claves en keys/. Si las reemplazas se invalidan todas las sesiones; usa --force para continuar.',
  );
  process.exit(1);
}

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
mkdirSync(dir, { recursive: true });
writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
writeFileSync(publicPath, publicKey.export({ type: 'spki', format: 'pem' }));
console.log('Claves creadas en keys/ (jwt-private.pem, jwt-public.pem).');
