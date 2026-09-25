import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { randomUUID, createECDH, randomBytes } from 'node:crypto';

process.loadEnvFile('.dev.vars');
const dbURL = process.env.SUPABASE_URL!;
if (!['localhost', '127.0.0.1'].includes(new URL(dbURL).hostname)) throw new Error('Tests require LOCAL Supabase');
const db = createClient(dbURL, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false } });
const userId = randomUUID(), email = `mobile-${userId}@example.test`, password = randomUUID();
const company = randomUUID(), lead = randomUUID();
const origin = 'http://localhost:4321';

test.beforeAll(async () => {
  const { error } = await db.auth.admin.createUser({ id: userId, email, password, email_confirm: true });
  expect(error).toBeNull();
  expect((await db.from('companies').insert({ id: company, name: 'บริษัททดสอบการแสดงผลบนโทรศัพท์มือถือชื่อยาวมาก จำกัด', owner_id: userId })).error).toBeNull();
  expect((await db.from('leads').insert({ id: lead, company_id: company, owner_id: userId, value: 123456789 })).error).toBeNull();
  expect((await db.from('renewals').insert({ company_id: company, cert: 'ISO 9001', audit_due: '2026-10-01', expiry: '2026-12-01', owner_id: userId })).error).toBeNull();
});

test.afterAll(async () => {
  await db.from('renewals').delete().eq('owner_id', userId);
  await db.from('leads').delete().eq('owner_id', userId);
  await db.from('companies').delete().eq('owner_id', userId);
  expect((await db.auth.admin.deleteUser(userId)).error).toBeNull();
});

test.beforeEach(async ({ page }) => {
  const response = await page.request.post('/api/auth/login', { form: { email, password }, headers: { Origin: origin } });
  expect(response.ok()).toBeTruthy();
  await page.goto('/');
  await expect(page.locator('#me-role')).toHaveText('sales');
});

test('subscription API is idempotent and enforces ownership and validation', async ({ page, playwright }) => {
  const profile = await (await page.request.get('/api/me')).json();
  expect(profile.vapidPublicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
  const crypto = createECDH('prime256v1'); crypto.generateKeys();
  const body = { endpoint: `https://fcm.googleapis.com/${userId}`, p256dh: crypto.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') };
  const headers = { Origin: origin };
  const create = await page.request.post('/api/push-subscriptions', { data: { ...body, owner_id: randomUUID() }, headers });
  expect(create.status()).toBe(201);
  const id = (await create.json()).id;
  const again = await page.request.post('/api/push-subscriptions', { data: body, headers });
  expect(again.status()).toBe(201);
  expect((await again.json()).id).toBe(id);
  expect((await db.from('push_subscriptions').select('owner_id').eq('id', id).single()).data?.owner_id).toBe(userId);
  const bad = await page.request.post('/api/push-subscriptions', { data: { ...body, endpoint: 'https://localhost/private' }, headers });
  expect(bad.status()).toBe(400);
  const changed = await page.request.post('/api/push-subscriptions', { data: { ...body, auth: randomBytes(16).toString('base64url') }, headers });
  expect(changed.status()).toBe(201);
  expect((await db.from('push_subscriptions').select('id').eq('endpoint', body.endpoint)).data).toHaveLength(1);
  const guest = await playwright.request.newContext({ baseURL: origin });
  expect((await guest.post('/api/push-subscriptions', { data: body, headers })).status()).toBe(401);
  await guest.dispose();
  const path = `/api/push-subscriptions?endpoint=${encodeURIComponent(body.endpoint)}`;
  expect((await page.request.delete(path, { headers })).status()).toBe(200);
  expect((await page.request.delete(path, { headers })).status()).toBe(404);
});

for (const width of [320, 375, 390, 768, 1280]) {
  test(`views fit ${width}px and mobile navigation/forms work`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    for (const view of ['dashboard', 'companies', 'renewals', 'pipeline', 'activities']) {
      if (width < 768) await page.getByRole('button', { name: 'เมนู', exact: true }).click();
      await page.locator(`#nav-${view}`).click();
      await expect(page.locator(`#view-${view}`)).toBeVisible();
      if (width < 768) {
        await expect.poll(async () => {
          const box = await page.locator('#sidebar').boundingBox();
          return box!.x + box!.width;
        }).toBeLessThanOrEqual(0);
      }
      const fits = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
      expect(fits, `${view} overflows viewport`).toBeTruthy();
      expect(await page.locator('main').evaluate(el => el.scrollWidth <= el.clientWidth), `${view} needs horizontal page scrolling`).toBeTruthy();
      if (view === 'dashboard') {
        expect(await page.locator('#kpi-value').evaluate(el => el.scrollWidth <= el.clientWidth), 'large sales totals must fit their card').toBeTruthy();
      }
      if (view === 'companies') {
        const search = await page.locator('#company-search').boundingBox();
        expect(search!.width).toBeGreaterThan(100);
        const add = page.getByRole('button', { name: '+ เพิ่มบริษัท', exact: true });
        const box = await add.boundingBox();
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
        await add.click();
        await expect(page.locator('#modal-company')).toBeVisible();
        await page.locator('#modal-company').getByRole('button', { name: 'ยกเลิก' }).click();
      }
    }
    if (width === 390) {
      await page.addStyleTag({ content: 'astro-dev-toolbar { display: none; }' });
      await page.screenshot({ path: 'test-results/mobile-390.png', fullPage: true });
    }
  });
}

test('mobile landscape drawer can reach notification controls and logout', async ({ page }) => {
  await page.setViewportSize({ width: 667, height: 375 });
  await page.getByRole('button', { name: 'เมนู', exact: true }).click();
  const logout = page.getByRole('button', { name: 'ออกจากระบบ', exact: true });
  await logout.scrollIntoViewIfNeeded();
  const box = await logout.boundingBox();
  expect(box!.y + box!.height).toBeLessThanOrEqual(375);
  await page.keyboard.press('Escape');
  await expect(page.locator('#sidebar-overlay')).toBeHidden();
});

test('PWA manifest, icons and worker are served without login', async ({ playwright }) => {
  const guest = await playwright.request.newContext({ baseURL: origin });
  for (const asset of ['/manifest.json', '/sw.js', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png']) {
    expect((await guest.get(asset)).status(), asset).toBe(200);
  }
  await guest.dispose();
});
