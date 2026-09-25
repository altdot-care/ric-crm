import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureNotifierEnv } from '../cron-notifications/scripts/notifier-env.mjs';

const fixture = (app, worker) => {
  const dir = mkdtempSync(join(tmpdir(), 'notifier-env-'));
  const appPath = join(dir, 'app.vars'), workerPath = join(dir, 'worker.vars');
  writeFileSync(appPath, app, { mode: 0o600 });
  if (worker !== null) writeFileSync(workerPath, worker, { mode: 0o600 });
  return { appPath, workerPath };
};
const value = (text, key) => text.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1];

test('adds the same random secret to both files and the URL to the app file, keeping existing lines', () => {
  const paths = fixture('SUPABASE_URL=http://127.0.0.1:54321\nVAPID_PUBLIC_KEY=abc\n', 'VAPID_PRIVATE_KEY=xyz\n');
  const { changed } = ensureNotifierEnv(paths);
  assert.deepEqual(changed.sort(), [paths.appPath, paths.workerPath].sort());
  const app = readFileSync(paths.appPath, 'utf8'), worker = readFileSync(paths.workerPath, 'utf8');
  assert.match(value(app, 'NOTIFIER_SECRET'), /^[0-9a-f]{64}$/);
  assert.equal(value(app, 'NOTIFIER_SECRET'), value(worker, 'NOTIFIER_SECRET'));
  assert.equal(value(app, 'NOTIFIER_URL'), 'http://localhost:8787');
  assert.equal(value(worker, 'NOTIFIER_URL'), undefined);
  assert.match(app, /SUPABASE_URL=http:\/\/127\.0\.0\.1:54321\nVAPID_PUBLIC_KEY=abc\n/);
  assert.match(worker, /^VAPID_PRIVATE_KEY=xyz\n/);
});

test('is idempotent: a second run changes nothing and keeps the secret', () => {
  const paths = fixture('A=1\n', 'B=2\n');
  ensureNotifierEnv(paths);
  const before = readFileSync(paths.appPath, 'utf8');
  assert.deepEqual(ensureNotifierEnv(paths).changed, []);
  assert.equal(readFileSync(paths.appPath, 'utf8'), before);
});

test('reuses a secret that already exists in one of the files', () => {
  const paths = fixture('A=1\n', `NOTIFIER_SECRET=${'a'.repeat(64)}\n`);
  ensureNotifierEnv(paths);
  assert.equal(value(readFileSync(paths.appPath, 'utf8'), 'NOTIFIER_SECRET'), 'a'.repeat(64));
});

test('refuses to overwrite two different secrets, and needs the worker file to exist', () => {
  assert.throws(() => ensureNotifierEnv(fixture(`NOTIFIER_SECRET=${'a'.repeat(64)}\n`, `NOTIFIER_SECRET=${'b'.repeat(64)}\n`)), /different/i);
  assert.throws(() => ensureNotifierEnv(fixture('A=1\n', null)), /setup-local/);
});

test('keeps files private (0600) and handles a file with no trailing newline', () => {
  const paths = fixture('A=1', 'B=2');
  ensureNotifierEnv(paths);
  assert.equal(statSync(paths.appPath).mode & 0o777, 0o600);
  assert.match(readFileSync(paths.appPath, 'utf8'), /^A=1\nNOTIFIER_SECRET=/);
});

test('astro declares both variables and both .example files document them', () => {
  const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
  const astro = read('../astro.config.mjs');
  assert.match(astro, /NOTIFIER_URL:\s*envField\.string\(\{ context: 'server', access: 'secret', optional: true \}\)/);
  assert.match(astro, /NOTIFIER_SECRET:\s*envField\.string\(\{ context: 'server', access: 'secret', optional: true \}\)/);
  assert.match(read('../.dev.vars.example'), /^NOTIFIER_URL=/m);
  assert.match(read('../.dev.vars.example'), /^NOTIFIER_SECRET=/m);
  assert.match(read('../cron-notifications/.dev.vars.example'), /^NOTIFIER_SECRET=/m);
});
