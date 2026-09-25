import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const read = path => readFileSync(path, 'utf8');
const get = (text, key) => text.match(new RegExp(`^${key}=(.+)$`, 'm'))?.[1];
const append = (text, lines) => `${text}${text && !text.endsWith('\n') ? '\n' : ''}${lines.join('\n')}\n`;

/**
 * Makes sure both .dev.vars files carry the same NOTIFIER_SECRET (web app ↔ Cron Worker) and the
 * app file knows where the Worker listens. Idempotent; never prints the secret.
 * Returns the paths it changed.
 */
export function ensureNotifierEnv({ appPath, workerPath, url = 'http://localhost:8787' }) {
  if (!existsSync(workerPath)) throw new Error('cron-notifications/.dev.vars is missing — run setup-local.mjs first');
  const app = existsSync(appPath) ? read(appPath) : '';
  const worker = read(workerPath);
  const inApp = get(app, 'NOTIFIER_SECRET'), inWorker = get(worker, 'NOTIFIER_SECRET');
  if (inApp && inWorker && inApp !== inWorker) throw new Error('NOTIFIER_SECRET is different in the two .dev.vars files — fix by hand');
  const secret = inApp || inWorker || randomBytes(32).toString('hex');

  const changed = [];
  const write = (path, text) => { writeFileSync(path, text, { mode: 0o600 }); chmodSync(path, 0o600); changed.push(path); };
  const appAdds = [];
  if (!inApp) appAdds.push(`NOTIFIER_SECRET=${secret}`);
  if (!get(app, 'NOTIFIER_URL')) appAdds.push(`NOTIFIER_URL=${url}`);
  if (appAdds.length) write(appPath, append(app, appAdds));
  if (!inWorker) write(workerPath, append(worker, [`NOTIFIER_SECRET=${secret}`]));
  return { changed };
}
