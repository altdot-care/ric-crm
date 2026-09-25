import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { handlePreview } from '../src/preview.ts';

const SECRET = 'test-secret-value-0123456789';
const env = { SUPABASE_URL: '', SUPABASE_SECRET_KEY: '', VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '', NOTIFIER_SECRET: SECRET };
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
