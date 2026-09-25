import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import webpush from 'web-push';
import { handlePreview } from '../src/preview.ts';

const SECRET = 'test-secret-value-0123456789-abcdef'; // the Worker requires at least 32 characters
const vapid = webpush.generateVAPIDKeys();
const env = { SUPABASE_URL: '', SUPABASE_SECRET_KEY: '', VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, NOTIFIER_SECRET: SECRET };
// Any database access through this client fails the test: auth checks must happen first.
const untouched = new Proxy({}, { get() { throw new Error('database must not be touched'); } }) as unknown as SupabaseClient;

const call = (path: string, init: { method?: string; auth?: string; body?: unknown } = {}, e: typeof env = env) =>
  handlePreview(new Request(`https://worker.test${path}`, {
    method: init.method ?? 'POST',
    headers: { 'Content-Type': 'application/json', ...(init.auth && { Authorization: init.auth }) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  }), e, { db: untouched });

test('unknown paths and methods are 404 even with a valid secret', async () => {
  assert.equal((await call('/preview/other', { auth: `Bearer ${SECRET}` })).status, 404);
  assert.equal((await call('/', { auth: `Bearer ${SECRET}` })).status, 404);
  assert.equal((await call('/preview/dry-run', { method: 'GET', auth: `Bearer ${SECRET}` })).status, 404);
});

test('preview is closed (503) when the Worker has no NOTIFIER_SECRET', async () => {
  const { NOTIFIER_SECRET: _omit, ...unset } = env;
  assert.equal((await call('/preview/dry-run', { auth: `Bearer ${SECRET}` }, unset as typeof env)).status, 503);
  assert.equal((await call('/preview/dry-run', { auth: 'Bearer ' }, { ...env, NOTIFIER_SECRET: '' })).status, 503);
});

test('a NOTIFIER_SECRET shorter than 32 characters counts as not configured (503), even with the right Bearer', async () => {
  const short = 'x'.repeat(31);
  assert.equal(short.length, 31);
  assert.equal((await call('/preview/dry-run', { auth: `Bearer ${short}` }, { ...env, NOTIFIER_SECRET: short })).status, 503);
  assert.equal((await call('/preview/test-push', { auth: `Bearer ${short}`, body: { ownerId: randomUUID() } }, { ...env, NOTIFIER_SECRET: short })).status, 503);
  assert.equal((await call('/preview/nope', { auth: `Bearer ${short}` }, { ...env, NOTIFIER_SECRET: short })).status, 404, 'route match still comes first');
});

test('test-push answers 503 when VAPID is not configured, before touching the database', async () => {
  const response = await call('/preview/test-push', { auth: `Bearer ${SECRET}`, body: { ownerId: randomUUID() } }, { ...env, VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '' });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'VAPID is not configured' });
});

test('missing, wrong or malformed credentials are 401 and never reach the database', async () => {
  for (const auth of [undefined, '', 'Bearer', 'Bearer wrong', `Basic ${SECRET}`, SECRET, `Bearer ${SECRET}x`]) {
    assert.equal((await call('/preview/dry-run', { auth })).status, 401, String(auth));
    assert.equal((await call('/preview/test-push', { auth, body: { ownerId: randomUUID() } })).status, 401, String(auth));
  }
});

test('test-push rejects a missing or non-uuid ownerId before touching the database', async () => {
  for (const body of [{}, { ownerId: 'nope' }, { ownerId: 42 }]) {
    assert.equal((await call('/preview/test-push', { auth: `Bearer ${SECRET}`, body })).status, 400, JSON.stringify(body));
  }
});

test('local database: test-push reaches only that owner, dry-run sends nothing, neither writes notification_log', async () => {
  process.loadEnvFile(new URL('../../.dev.vars', import.meta.url).pathname);
  const url = process.env.SUPABASE_URL!;
  assert.ok(['localhost', '127.0.0.1'].includes(new URL(url).hostname), 'tests must use LOCAL Supabase');
  const key = process.env.SUPABASE_SECRET_KEY!;
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const owner = randomUUID(), other = randomUUID(), company = randomUUID(), lead = randomUUID(), followup = randomUUID();
  // Scope dry-run's real REST queries to the throwaway owner so nobody's real reminders are read.
  const scoped = createClient(url, key, { auth: { persistSession: false }, global: { fetch: (input, init) => {
    const target = new URL(String(input));
    if (['/rest/v1/activities', '/rest/v1/renewals'].includes(target.pathname)) target.searchParams.set('owner_id', `eq.${owner}`);
    return fetch(target, init);
  } } });
  const ok = (r: { error: unknown }) => assert.equal(r.error, null);
  const good = `https://fcm.googleapis.com/${owner}/good`, gone = `https://fcm.googleapis.com/${owner}/gone`, foreign = `https://fcm.googleapis.com/${other}/x`;
  const sentTo: string[] = [];
  const send = async (sub: { endpoint: string }) => { sentTo.push(sub.endpoint); return sub.endpoint === gone ? 410 : 201; };
  const now = new Date('2026-09-26T03:00:00Z'); // 10:00 on Sep 26 in Bangkok
  const call2 = (path: string, body: unknown, deps: Parameters<typeof handlePreview>[2]) =>
    handlePreview(new Request(`https://worker.test${path}`, { method: 'POST', headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env, deps);
  const logCount = async () => (await db.from('notification_log').select('id', { count: 'exact', head: true })).count;
  try {
    for (const id of [owner, other]) ok(await db.auth.admin.createUser({ id, email: `preview-${id}@example.test`, password: randomUUID(), email_confirm: true }));
    ok(await db.from('companies').insert({ id: company, name: 'Preview test co', owner_id: owner }));
    ok(await db.from('leads').insert({ id: lead, company_id: company, owner_id: owner }));
    ok(await db.from('activities').insert({ id: followup, lead_id: lead, type: 'call', description: 'โทรกลับ', followup: '2026-09-26', followup_time: '09:30', owner_id: owner }));
    const keys = { p256dh: 'B' + 'a'.repeat(86), auth: 'b'.repeat(22) };
    ok(await db.from('push_subscriptions').insert([
      { owner_id: owner, endpoint: good, ...keys }, { owner_id: owner, endpoint: gone, ...keys }, { owner_id: other, endpoint: foreign, ...keys },
    ]));
    const logsBefore = await logCount();

    const pushed = await call2('/preview/test-push', { ownerId: owner }, { db, send, now });
    assert.equal(pushed.status, 200);
    assert.deepEqual(await pushed.json(), { devices: 2, sent: 1, failed: 1, pruned: 1 });
    assert.deepEqual(sentTo.sort(), [good, gone].sort(), "only the owner's own devices, never another user's");
    assert.equal((await db.from('push_subscriptions').select('id').eq('endpoint', gone)).data?.length, 0, 'the dead device is pruned');
    assert.equal(await logCount(), logsBefore, 'test-push must not write notification_log');

    const empty = await call2('/preview/test-push', { ownerId: randomUUID() }, { db, send, now });
    assert.deepEqual(await empty.json(), { devices: 0, sent: 0, failed: 0, pruned: 0 });

    sentTo.length = 0;
    const dry = await call2('/preview/dry-run', {}, { db: scoped, send, now });
    assert.equal(dry.status, 200);
    const body = await dry.json() as { now: string; candidates: { kind: string; title: string; body: string; ownerId: string; alreadySent: boolean }[] };
    assert.equal(body.now, '2026-09-26 10:00');
    assert.deepEqual(body.candidates, [{ kind: 'followup_due', title: 'ถึงเวลานัดติดตาม 09:30', body: 'Preview test co: โทรกลับ', ownerId: owner, alreadySent: false }]);
    assert.equal(sentTo.length, 0, 'dry-run must not send');
    assert.equal(await logCount(), logsBefore, 'dry-run must not write notification_log');

    ok(await db.from('notification_log').insert({ kind: 'followup_due', entity_id: followup }));
    const again = await (await call2('/preview/dry-run', {}, { db: scoped, send, now })).json() as { candidates: { alreadySent: boolean }[] };
    assert.equal(again.candidates[0].alreadySent, true, 'items already sent are flagged');
  } finally {
    await db.from('notification_log').delete().eq('entity_id', followup);
    await db.from('push_subscriptions').delete().in('owner_id', [owner, other]);
    await db.from('activities').delete().eq('owner_id', owner);
    await db.from('leads').delete().eq('owner_id', owner);
    await db.from('companies').delete().eq('owner_id', owner);
    for (const id of [owner, other]) await db.auth.admin.deleteUser(id);
  }
});

test('dry-run looks up alreadySent with distinct entity ids in chunks of 100', async () => {
  const now = new Date('2026-09-26T03:00:00Z'); // 10:00 on Sep 26 in Bangkok
  const followups = Array.from({ length: 120 }, (_, i) => ({ id: randomUUID(), description: `f${i}`, followup_time: null, owner_id: 'o', lead: null }));
  // Each renewal yields two candidates (audit + expiry) with the same entity id.
  const renewals = Array.from({ length: 30 }, () => ({ id: randomUUID(), cert: 'ISO', audit_due: '2026-10-01', expiry: '2026-10-02', owner_id: 'o', company: null }));
  const lookups: string[][] = [];
  const fake = {
    from(table: string) {
      const builder = {
        select: () => builder, eq: () => builder, or: () => builder, order: () => builder, range: () => builder,
        in(_column: string, ids: string[]) { lookups.push(ids); return builder; },
        then(resolve: (value: unknown) => void) {
          resolve({ data: table === 'activities' ? followups : table === 'renewals' ? renewals : [], error: null });
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
  const response = await handlePreview(new Request('https://worker.test/preview/dry-run', { method: 'POST', headers: { Authorization: `Bearer ${SECRET}` } }), env, { db: fake, now });
  assert.equal(response.status, 200);
  const body = await response.json() as { candidates: unknown[] };
  assert.equal(body.candidates.length, 180);
  assert.deepEqual(lookups.map(ids => ids.length), [100, 50]);
  assert.equal(new Set(lookups.flat()).size, 150, 'no id is looked up twice');
});
