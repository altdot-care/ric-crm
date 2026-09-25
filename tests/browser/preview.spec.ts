import { test, expect, type Browser } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';

process.loadEnvFile('.dev.vars');
const dbURL = process.env.SUPABASE_URL!;
if (!['localhost', '127.0.0.1'].includes(new URL(dbURL).hostname)) throw new Error('Tests require LOCAL Supabase');
const db = createClient(dbURL, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false } });
const origin = 'http://localhost:4321';
const secret = process.env.NOTIFIER_SECRET!;
const notifierPort = Number(new URL(process.env.NOTIFIER_URL!).port);

const makeUser = (label: string) => ({ id: randomUUID(), email: `${label}-${randomUUID()}@example.test`, password: randomUUID() });
const sales = makeUser('preview-sales'), root = makeUser('preview-root');
const calls: { path: string; auth: string | undefined; body: string }[] = [];
let stub: Server;

test.beforeAll(async () => {
  expect(secret, 'run: node cron-notifications/scripts/setup-notifier.mjs, then restart pnpm dev').toBeTruthy();
  for (const u of [sales, root]) {
    expect((await db.auth.admin.createUser({ id: u.id, email: u.email, password: u.password, email_confirm: true })).error).toBeNull();
  }
  expect((await db.from('profiles').update({ role: 'root' }).eq('id', root.id)).error).toBeNull();
  // Stand-in for the Cron Worker: checks the secret like the real one and records what the web app sent.
  stub = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      calls.push({ path: req.url ?? '', auth: req.headers.authorization, body });
      if (req.headers.authorization !== `Bearer ${secret}`) { res.writeHead(401).end('{}'); return; }
      res.setHeader('Content-Type', 'application/json');
      res.end(req.url === '/preview/test-push'
        ? JSON.stringify({ devices: 2, sent: 1, failed: 1, pruned: 0 })
        : JSON.stringify({ now: '2026-09-26 10:00', candidates: [
            { kind: 'followup_due', title: 'ถึงเวลานัดติดตาม 09:30', body: 'บริษัททดสอบ: โทรกลับ', ownerId: root.id, alreadySent: false },
            { kind: 'renewal_expiry_due', title: 'ใบรับรองใกล้หมดอายุ', body: 'บริษัททดสอบ — ISO 9001 (อีก 5 วัน)', ownerId: root.id, alreadySent: true },
          ] }));
    });
  });
  await new Promise<void>((resolve, reject) => stub.once('error', e => reject(new Error(`port ${notifierPort} busy — stop "wrangler dev" while running this spec (${e.message})`))).listen(notifierPort, resolve));
});

test.afterAll(async () => {
  await new Promise(resolve => stub.close(resolve));
  await db.from('push_subscriptions').delete().eq('owner_id', root.id);
  for (const u of [sales, root]) await db.auth.admin.deleteUser(u.id);
});

async function signIn(browser: Browser, u: { email: string; password: string }) {
  const context = await browser.newContext({ baseURL: origin });
  const login = await context.request.post('/api/auth/login', { form: { email: u.email, password: u.password }, headers: { Origin: origin } });
  expect(login.ok()).toBeTruthy();
  return context;
}

test('a non-root sees no menu entry, is sent away from /preview, and gets 403 from every preview API', async ({ browser }) => {
  const context = await signIn(browser, sales);
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.locator('#me-role')).toHaveText('sales');
  await expect(page.locator('#nav-preview')).toBeHidden();
  await page.goto('/preview');
  await expect(page).toHaveURL(`${origin}/`);
  const headers = { Origin: origin };
  expect((await context.request.post('/api/preview/test-push', { headers })).status()).toBe(403);
  expect((await context.request.post('/api/preview/dry-run', { headers })).status()).toBe(403);
  expect((await context.request.get('/api/preview/subscriptions')).status()).toBe(403);
  expect(calls.filter(c => c.path.startsWith('/preview')).length, 'the Worker was never called on behalf of a non-root').toBe(0);
  await context.close();
});

test('an anonymous visitor cannot use the preview API', async ({ request }) => {
  expect((await request.post('/api/preview/test-push', { headers: { Origin: origin } })).status()).toBe(401);
});

test('root sees the menu entry and can run all three tests', async ({ browser }) => {
  const context = await signIn(browser, root);
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.locator('#me-role')).toHaveText('root');
  await expect(page.locator('#nav-preview')).toBeVisible();
  await page.locator('#nav-preview').click();
  await expect(page).toHaveURL(`${origin}/preview`);

  await page.locator('#btn-test-push').click();
  await expect(page.locator('#out-test-push')).toContainText('ส่งสำเร็จ 1 จาก 2 อุปกรณ์');
  const push = calls.filter(c => c.path === '/preview/test-push').at(-1)!;
  expect(push.auth).toBe(`Bearer ${secret}`);
  expect(JSON.parse(push.body)).toEqual({ ownerId: root.id });

  await page.locator('#btn-subs').click();
  await expect(page.locator('#out-subs')).toContainText('ยังไม่มีอุปกรณ์');
  expect((await db.from('push_subscriptions').insert({ owner_id: root.id, endpoint: `https://fcm.googleapis.com/${root.id}/x`, p256dh: 'B' + 'a'.repeat(86), auth: 'b'.repeat(22) })).error).toBeNull();
  await page.locator('#btn-subs').click();
  await expect(page.locator('#out-subs')).toContainText('fcm.googleapis.com');
  await expect(page.locator('#out-subs')).not.toContainText(root.id);

  await page.locator('#btn-dry-run').click();
  await expect(page.locator('#out-dry-run')).toContainText('2026-09-26 10:00');
  await expect(page.locator('#out-dry-run')).toContainText('ถึงเวลานัดติดตาม 09:30');
  await expect(page.locator('#out-dry-run')).toContainText('ส่งแล้ว');
  await context.close();
});

test('preview fits a 320px phone without horizontal scroll', async ({ browser }) => {
  const context = await signIn(browser, root);
  const page = await context.newPage();
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/preview');
  await page.locator('#btn-dry-run').click();
  await expect(page.locator('#out-dry-run')).toContainText('ถึงเวลานัดติดตาม 09:30');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  for (const id of ['btn-test-push', 'btn-subs', 'btn-dry-run']) {
    expect((await page.locator(`#${id}`).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  await context.close();
});
