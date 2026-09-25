import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';

function browser({ ios = false, installed = false, supported = true, existing = null, owned = true, saveFails = false, deleteFails = false, noRegistration = false } = {}) {
  const nodes = new Map();
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, { checked: false, disabled: true, textContent: '', classList: { add() {}, remove() {} } });
    return nodes.get(id);
  };
  const events = [];
  let sub = existing;
  const registration = { pushManager: {
    getSubscription: async () => sub,
    subscribe: async () => (sub = { endpoint: 'https://fcm.googleapis.com/push', toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/push', keys: { p256dh: 'x', auth: 'y' } }), unsubscribe: async () => { events.push('unsubscribe'); sub = null; return true; } }),
  } };
  const context = { URL, Uint8Array, atob, setTimeout, clearTimeout,
    document: { getElementById: get },
    navigator: { userAgent: ios ? 'iPhone' : 'Chrome', standalone: installed, serviceWorker: { ready: noRegistration ? new Promise(() => {}) : Promise.resolve(registration), getRegistration: async () => noRegistration ? undefined : registration } },
    Notification: { permission: 'default', requestPermission: () => { events.push('permission'); return Promise.resolve('granted'); } },
    fetch: async (_url, options = {}) => {
      events.push(options.method || 'GET');
      if (saveFails && options.method === 'POST') return { ok: false, status: 500, json: async () => ({ error: 'Unavailable' }) };
      if (deleteFails && options.method === 'DELETE') return { ok: false, status: 503, json: async () => ({ error: 'Unavailable' }) };
      return { ok: true, status: 200, json: async () => owned ? { id: 'own' } : null };
    },
    console,
  };
  context.window = { matchMedia: () => ({ matches: installed }), ...(supported && { PushManager: {} }), Notification: context.Notification };
  const path = new URL('../public/push-notifications.js', import.meta.url);
  assert.ok(existsSync(path), 'push UI module exists');
  vm.runInNewContext(readFileSync(path, 'utf8'), context);
  return { window: context.window, nodes, get, events };
}

test('iOS browser without PushManager still shows install instructions', async () => {
  const b = browser({ ios: true, supported: false });
  await b.window.initPushNotifications('AAAA');
  assert.match(b.get('notif-status').textContent, /หน้าจอโฮม/);
  assert.equal(b.get('notif-toggle').disabled, true);
});

test('permission is requested synchronously on user gesture and failed save rolls back browser subscription', async () => {
  const b = browser({ saveFails: true });
  await b.window.initPushNotifications('AAAA');
  b.get('notif-toggle').checked = true;
  const pending = b.window.onNotifToggleChange();
  assert.equal(b.events[0], 'permission');
  await pending;
  assert.ok(b.events.includes('unsubscribe'));
  assert.equal(b.get('notif-toggle').checked, false);
  assert.match(b.get('notif-status').textContent, /Unavailable/);
});

test('switching accounts revokes the previous browser subscription', async () => {
  let revoked = false;
  const b = browser({ owned: false, existing: { endpoint: 'https://fcm.googleapis.com/old', unsubscribe: async () => { revoked = true; return true; } } });
  await b.window.initPushNotifications('AAAA');
  assert.equal(revoked, true);
  assert.equal(b.get('notif-toggle').checked, false);
});

test('logout without a service worker registration does not wait for activation', async () => {
  const b = browser({ noRegistration: true });
  let submitted = false;
  await b.window.logoutWithNotifications({ submit() { submitted = true; } });
  assert.equal(submitted, true);
});

for (const serverFails of [true, false]) {
  test(`logout proceeds if ${serverFails ? 'browser revocation' : 'server deletion'} succeeds independently`, async () => {
    let revoked = false, submitted = false;
    const existing = { endpoint: 'https://fcm.googleapis.com/old', unsubscribe: async () => {
      revoked = true;
      if (!serverFails) throw new Error('Browser error');
      return true;
    } };
    const b = browser({ existing, deleteFails: serverFails });
    await b.window.logoutWithNotifications({ submit() { submitted = true; } });
    assert.equal(revoked, true);
    assert.equal(submitted, true);
  });
}
