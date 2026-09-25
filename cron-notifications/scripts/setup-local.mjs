import { ensureNotifierEnv } from './notifier-env.mjs';
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import webpush from 'web-push';

const appPath = new URL('../../.dev.vars', import.meta.url);
const workerPath = new URL('../.dev.vars', import.meta.url);
process.loadEnvFile(appPath.pathname);
if (!['localhost', '127.0.0.1'].includes(new URL(process.env.SUPABASE_URL).hostname)) {
  throw new Error('Local setup requires a localhost Supabase URL');
}
if (!process.env.SUPABASE_SECRET_KEY) throw new Error('Local SUPABASE_SECRET_KEY required');
if (existsSync(workerPath)) throw new Error('Worker .dev.vars already exists; keep existing keys or update manually');
if (process.env.VAPID_PUBLIC_KEY) throw new Error('App already has a VAPID key; configure the matching private key manually');
const keys = webpush.generateVAPIDKeys();
writeFileSync(workerPath, [
  `SUPABASE_URL=${process.env.SUPABASE_URL}`,
  `SUPABASE_SECRET_KEY=${process.env.SUPABASE_SECRET_KEY}`,
  `VAPID_PUBLIC_KEY=${keys.publicKey}`,
  `VAPID_PRIVATE_KEY=${keys.privateKey}`,
  'VAPID_SUBJECT=mailto:support@ricroyal.co.th', '',
].join('\n'), { mode: 0o600 });
const app = readFileSync(appPath, 'utf8').replace(/^VAPID_PUBLIC_KEY=.*\n?/gm, '');
writeFileSync(appPath, `${app.trimEnd()}\nVAPID_PUBLIC_KEY=${keys.publicKey}\n`);
chmodSync(appPath, 0o600);
ensureNotifierEnv({ appPath: appPath.pathname, workerPath: workerPath.pathname });
console.log('Local VAPID keys saved in ignored .dev.vars files. Restart the app dev server.');
