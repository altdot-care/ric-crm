import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callNotifier, notifierResponse } from '../src/lib/notifier.ts';
import { endpointHost } from '../src/lib/push-endpoint.ts';

const config = (fetchImpl, extra = {}) => ({ url: 'http://localhost:8787', secret: 's3cret', fetchImpl, ...extra });

test('without URL or secret the notifier is "not configured" (503) and nothing is fetched', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return Response.json({}); };
  for (const missing of [{ url: undefined }, { secret: undefined }, { url: '' }, { secret: '' }]) {
    const result = await callNotifier('/preview/dry-run', {}, config(fetchImpl, missing));
    assert.deepEqual([result.ok, result.status], [false, 503]);
  }
  assert.equal(called, false);
});

test('sends a POST to the Worker path with the Bearer secret and JSON body, returns its data', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url: String(url), init }; return Response.json({ devices: 1, sent: 1, failed: 0, pruned: 0 }); };
  const result = await callNotifier('/preview/test-push', { ownerId: 'abc' }, config(fetchImpl));
  assert.deepEqual(result, { ok: true, data: { devices: 1, sent: 1, failed: 0, pruned: 0 } });
  assert.equal(seen.url, 'http://localhost:8787/preview/test-push');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers.Authorization, 'Bearer s3cret');
  assert.equal(seen.init.body, JSON.stringify({ ownerId: 'abc' }));
  assert.equal(seen.init.redirect, 'manual');
});

test('a network failure, a non-2xx reply and a non-JSON reply are all 502 with a Thai message', async () => {
  const cases = [
    async () => { throw new Error('connect ECONNREFUSED'); },
    async () => new Response('nope', { status: 401 }),
    async () => new Response('<html>', { status: 200 }),
  ];
  for (const fetchImpl of cases) {
    const result = await callNotifier('/preview/dry-run', {}, config(fetchImpl));
    assert.equal(result.ok, false);
    assert.equal(result.status, 502);
    assert.match(result.error, /Cron Worker/);
    assert.doesNotMatch(result.error, /s3cret|ECONNREFUSED/, 'never leak the secret or raw errors');
  }
});

test('a redirect from the Worker is never followed and is a 502 failure without the secret', async () => {
  let calls = 0, init;
  const fetchImpl = async (_url, i) => { calls++; init = i; return new Response(null, { status: 302, headers: { Location: 'https://evil.example/collect' } }); };
  const result = await callNotifier('/preview/dry-run', {}, config(fetchImpl));
  assert.equal(calls, 1, 'the redirect target must not be requested');
  assert.equal(init.redirect, 'manual');
  assert.equal(result.ok, false);
  assert.equal(result.status, 502);
  assert.match(result.error, /[\u0E00-\u0E7F]/, 'Thai message');
  assert.doesNotMatch(result.error, /s3cret|evil\.example/);
});

test('notifierResponse maps results to HTTP responses', async () => {
  const ok = notifierResponse({ ok: true, data: { a: 1 } });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { a: 1 });
  const bad = notifierResponse({ ok: false, status: 503, error: 'ยังไม่ได้ตั้งค่า' });
  assert.equal(bad.status, 503);
  assert.deepEqual(await bad.json(), { error: 'ยังไม่ได้ตั้งค่า' });
});

test('every preview route is root-only and takes its target from the session, not the request', () => {
  const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
  for (const file of ['test-push', 'dry-run', 'subscriptions']) {
    assert.match(read(`../src/pages/api/preview/${file}.ts`), /requireRoot\(locals\)/, file);
  }
  const push = read('../src/pages/api/preview/test-push.ts');
  assert.match(push, /ownerId:\s*locals\.user!\.id/);
  assert.doesNotMatch(push, /request\.json|parseBody/, 'test-push must not read a target from the request');
  const subs = read('../src/pages/api/preview/subscriptions.ts');
  assert.doesNotMatch(subs, /p256dh|\bauth\b\s*[,:)]/, 'never return encryption keys');
});

test('endpointHost returns only the hostname, or null for an unparseable endpoint', () => {
  assert.equal(endpointHost('https://fcm.googleapis.com/fcm/send/abc'), 'fcm.googleapis.com');
  assert.equal(endpointHost('https://user:pw@example.com:8443/x?y=1'), 'example.com');
  for (const bad of ['not a url', '', 'https://']) assert.equal(endpointHost(bad), null, JSON.stringify(bad));
});
