import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []);

test("no source uses fetch option redirect: 'error' (Cloudflare Workers reject it)", () => {
  const files = [...walk(join(root, 'src')), ...walk(join(root, 'cron-notifications/src'))];
  assert.ok(files.some(f => f.endsWith('notifier.ts')) && files.some(f => f.endsWith('notifications.ts')));
  const offenders = files.filter(f => /redirect\s*:\s*['"]error['"]/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, [], `redirect: 'error' throws in the Workers runtime ("TypeError: Invalid redirect value, must be one of "follow" or "manual" ("error" won't be implemented since it does not make sense at the edge; use "manual" ...)"). Use redirect: 'manual' and treat a 3xx as a failure.`);
});
