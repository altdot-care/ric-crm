import { ensureNotifierEnv } from './notifier-env.mjs';

const { changed } = ensureNotifierEnv({
  appPath: new URL('../../.dev.vars', import.meta.url).pathname,
  workerPath: new URL('../.dev.vars', import.meta.url).pathname,
});
console.log(changed.length ? `Updated (secret not shown): ${changed.join(', ')}` : 'NOTIFIER_* already configured — nothing changed.');
console.log('Restart `pnpm dev` (web) and the Worker so they pick up the new variables.');
