import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as schemas from '../src/lib/schemas.ts';

test('subscriptions reject arbitrary destinations and invalid encryption keys', () => {
  assert.ok(schemas.pushSubscriptionCreate, 'subscription schema exists');
  const valid = { endpoint: 'https://fcm.googleapis.com/fcm/send/example', p256dh: 'B' + 'a'.repeat(86), auth: 'b'.repeat(22) };
  assert.equal(schemas.pushSubscriptionCreate.safeParse(valid).success, true);
  for (const endpoint of ['http://fcm.googleapis.com/send/x', 'https://localhost/push', 'https://fcm.googleapis.com.evil.test/x', 'https://fcm.googleapis.com:8443/x', 'https://user:pass@fcm.googleapis.com/x']) {
    assert.equal(schemas.pushSubscriptionCreate.safeParse({ ...valid, endpoint }).success, false, endpoint);
  }
  assert.equal(schemas.pushSubscriptionCreate.safeParse({ ...valid, auth: 'bad' }).success, false);
  assert.equal(schemas.pushSubscriptionCreate.safeParse({ ...valid, p256dh: 'bad' }).success, false);
  assert.equal(schemas.pushSubscriptionCreate.parse({ ...valid, owner_id: 'attacker' }).owner_id, undefined);
});

function worker() {
  const listeners = {};
  const shown = [], opened = [];
  const context = { URL, self: {
    location: { origin: 'https://crm.example.test' },
    addEventListener: (name, fn) => { listeners[name] = fn; },
    registration: { showNotification: async (...args) => { shown.push(args); } },
    clients: { openWindow: async url => opened.push(url), matchAll: async () => [] },
  } };
  vm.runInNewContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), context);
  return { listeners, shown, opened };
}

test('push shows notification and survives malformed payloads', async () => {
  const { listeners, shown } = worker();
  assert.equal(typeof listeners.push, 'function');
  for (const data of [null, { json: () => { throw new Error('bad JSON'); } }, { json: () => ({ title: 'Due', body: 'Call', url: '/' }) }]) {
    let pending;
    listeners.push({ data, waitUntil: p => { pending = p; } });
    await pending;
  }
  assert.equal(shown.length, 3);
  assert.equal(shown[2][0], 'Due');
  assert.equal(shown[2][1].body, 'Call');
});

test('notification click only opens the CRM origin', async () => {
  const { listeners, opened } = worker();
  assert.equal(typeof listeners.notificationclick, 'function');
  for (const url of ['https://evil.test/phishing', '/?from=push']) {
    let pending;
    listeners.notificationclick({ notification: { data: { url }, close() {} }, waitUntil: p => { pending = p; } });
    await pending;
  }
  assert.deepEqual(opened, ['https://crm.example.test/', 'https://crm.example.test/?from=push']);
});
