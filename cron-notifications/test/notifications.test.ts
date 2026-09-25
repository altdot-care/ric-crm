import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createECDH, randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import webpush from 'web-push';

test('calendar dates use Bangkok midnight and exact 0/30-day boundaries', async () => {
  const module = await import('../src/notifications.ts');
  assert.equal(module.daysUntil('2026-09-26', new Date('2026-09-25T18:00:00Z')), 0);
  assert.equal(module.daysUntil('2026-09-25', new Date('2026-09-25T18:00:00Z')), -1);
  assert.equal(module.daysUntil('2026-10-26', new Date('2026-09-25T18:00:00Z')), 30);
});

test('real push transport encrypts and signs payload, blocks redirects and arbitrary destinations', async () => {
  const { sendPush } = await import('../src/notifications.ts');
  const keys = webpush.generateVAPIDKeys();
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
  const env = { SUPABASE_URL: '', SUPABASE_SECRET_KEY: '', VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey };
  const subscription = { endpoint: 'https://fcm.googleapis.com/test', keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (url, options) => {
    requests++;
    assert.equal(url, subscription.endpoint);
    assert.equal(options?.method, 'POST');
    assert.equal(options?.redirect, 'error');
    const headers = new Headers(options?.headers);
    assert.equal(headers.get('content-encoding'), 'aes128gcm');
    assert.match(headers.get('authorization')!, /^vapid t=/);
    assert.ok(options?.body instanceof Uint8Array);
    assert.ok(!Buffer.from(options.body).includes(Buffer.from('secret reminder')));
    return new Response('', { status: 201 });
  };
  try {
    assert.equal(await sendPush(env, subscription, JSON.stringify({ body: 'secret reminder' })), 201);
    await assert.rejects(sendPush(env, { ...subscription, endpoint: 'https://localhost/private' }, '{}'), /Unsupported/);
    assert.equal(requests, 1);
  } finally { globalThis.fetch = original; }
});

test('local database: candidates, opt-in, concurrent dedup, failed delivery and dead subscription pruning', async () => {
  const { run, findCandidates } = await import('../src/notifications.ts');
  process.loadEnvFile(new URL('../../.dev.vars', import.meta.url).pathname);
  const url = process.env.SUPABASE_URL!;
  assert.ok(['localhost', '127.0.0.1'].includes(new URL(url).hostname), 'tests must use LOCAL Supabase');
  const secret = process.env.SUPABASE_SECRET_KEY!;
  assert.ok(secret, 'local service key required');
  const owner = randomUUID();
  const db = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
  // Scope the real REST queries to a throwaway owner; no existing user's reminders are touched.
  const scoped = createClient(url, secret, { auth: { persistSession: false }, global: { fetch: (input, init) => {
    const target = new URL(String(input));
    if (['/rest/v1/activities', '/rest/v1/renewals'].includes(target.pathname)) target.searchParams.set('owner_id', `eq.${owner}`);
    return fetch(target, init);
  } } });
  const company = randomUUID(), lead = randomUUID();
  const due = randomUUID(), past = randomUUID(), renewal = randomUUID();
  const now = new Date('2026-09-25T18:00:00Z'); // Sep 26 in Bangkok
  const keys = webpush.generateVAPIDKeys();
  const env = { SUPABASE_URL: url, SUPABASE_SECRET_KEY: secret, VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey };
  const good = randomUUID(), dead = randomUUID();
  const sent: string[] = [];
  const send = async (subscription: { endpoint: string }, payload: string) => {
    if (subscription.endpoint.endsWith('/dead')) return 410;
    sent.push(payload);
    return 201;
  };
  const ok = (result: { error: unknown }) => assert.equal(result.error, null);
  try {
    ok(await db.auth.admin.createUser({ id: owner, email: `push-${owner}@example.test`, password: randomUUID(), email_confirm: true }));
    ok(await db.from('companies').insert({ id: company, name: 'Notification test', owner_id: owner }));
    ok(await db.from('leads').insert({ id: lead, company_id: company, owner_id: owner }));
    // Only a follow-up dated today notifies: past ones have no "done" state, so they would nag forever.
    ok(await db.from('activities').insert([
      { id: due, lead_id: lead, type: 'call', description: 'due', followup: '2026-09-26', owner_id: owner },
      { id: past, lead_id: lead, type: 'call', description: 'past', followup: '2026-09-25', owner_id: owner },
      { id: randomUUID(), lead_id: lead, type: 'call', description: 'future', followup: '2026-09-27', owner_id: owner },
      { id: randomUUID(), lead_id: lead, type: 'note', description: 'no follow-up', owner_id: owner },
    ]));
    ok(await db.from('renewals').insert({ id: renewal, company_id: company, cert: 'ISO 9001', audit_due: '2026-10-26', expiry: '2026-09-25', owner_id: owner }));
    const candidates = await findCandidates(scoped, now);
    assert.deepEqual(candidates.map(c => c.kind).sort(), ['followup_due', 'renewal_audit_due', 'renewal_expiry_overdue']);
    await run(env, { client: scoped, send, now });
    const logs = () => db.from('notification_log').select('*').in('entity_id', [due, past, renewal]);
    assert.equal((await logs()).data?.length, 0, 'no devices must not consume the milestone');

    const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
    const p256dh = ecdh.getPublicKey().toString('base64url'), auth = randomBytes(16).toString('base64url');
    ok(await db.from('push_subscriptions').insert([
      { id: good, owner_id: owner, endpoint: `https://fcm.googleapis.com/${owner}/good`, p256dh, auth },
      { id: dead, owner_id: owner, endpoint: `https://fcm.googleapis.com/${owner}/dead`, p256dh, auth },
    ]));
    await Promise.all([run(env, { client: scoped, send, now }), run(env, { client: scoped, send, now })]);
    assert.equal(sent.length, 3, 'one send per milestone even for concurrent jobs');
    assert.equal((await logs()).data?.length, 3);
    assert.equal((await db.from('push_subscriptions').select('*').eq('id', dead)).data?.length, 0);
    await run(env, { client: scoped, send, now });
    assert.equal(sent.length, 3, 'rerun must not resend');
    assert.ok(sent.every(p => JSON.parse(p).url === '/'));

    // Independently cross the other renewal milestones; temporary failures stay claimed.
    ok(await db.from('renewals').update({ audit_due: '2026-09-25', expiry: '2026-10-26' }).eq('id', renewal));
    const failing = async () => 503;
    const result = await run(env, { client: scoped, send: failing, now });
    assert.equal(result.failed, 2);
    assert.equal((await logs()).data?.length, 5);
    await run(env, { client: scoped, send, now });
    assert.equal(sent.length, 3, 'no retries after failed attempt, as specified');
  } finally {
    ok(await db.from('notification_log').delete().in('entity_id', [due, past, renewal]));
    ok(await db.from('activities').delete().eq('owner_id', owner));
    ok(await db.from('renewals').delete().eq('owner_id', owner));
    ok(await db.from('leads').delete().eq('owner_id', owner));
    ok(await db.from('companies').delete().eq('owner_id', owner));
    ok(await db.auth.admin.deleteUser(owner));
  }
});
