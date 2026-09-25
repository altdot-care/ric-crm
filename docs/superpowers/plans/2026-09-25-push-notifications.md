# Push Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user opt in to push notifications (Android + iOS) for their leads' next-action due dates and their certificate renewals' audit/expiry dates, delivered once per (item, milestone) by a daily Cloudflare Cron Trigger.

**Architecture:** Two new Supabase tables (`push_subscriptions`, `notification_log`) back a client-side subscribe/unsubscribe flow (Web Push API + the existing `/sw.js`) and a brand-new, independently-deployed Cloudflare Worker (`cron-notifications/`) that runs daily, finds due items, dedupes via `notification_log`, and sends via the `web-push` package.

**Tech Stack:** Astro + Cloudflare Workers (ric-crm), Supabase/Postgres + RLS (supabase), a second standalone Cloudflare Worker with its own Cron Trigger, `web-push` (VAPID Web Push protocol), Zod.

**Spec:** `docs/superpowers/specs/2026-09-25-push-notifications-design.md`

## Global Constraints

- Two repos: `ric-crm` (this repo, plus the new `cron-notifications/` directory inside it) and `supabase` (sibling checkout at `/Users/iddh/Workspaces/supabase`).
- `supabase db reset` run directly against the shared local Postgres works fine from either repo's plain checkout — no worktree, no copy-to-original-checkout dance.
- RLS convention for every OTHER table in this app: `select using(true)`. **`push_subscriptions` deliberately does not follow this** — `select`/`delete` are `owner_id = (select auth.uid())` only, no admin override, because a push endpoint is a device secret, not business data. `notification_log` has RLS enabled with **zero policies** (nobody via anon/authenticated can touch it; only the service-role key, used only by the cron Worker, can). Do not "fix" either of these to match the usual pattern — the deviation is deliberate and documented in the spec.
- API route shape: `parseBody(request, schema) → early-return Response on failure → dbError(error) on DB failure → json(data, status)`. Match every existing route.
- Commit style: `type: short imperative summary`, ending with `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` — match `git log` in each repo/directory.
- **Task 10 (deploy) is not to be executed automatically** — it creates live production infrastructure (a new Cloudflare Worker, a Cron Trigger, production secrets). Stop and get explicit human confirmation immediately before running any `wrangler deploy` or `wrangler secret put` command in that task, even if every earlier task completed cleanly.
- Line numbers cited in "Modify" steps were correct when this plan was written but may drift — locate blocks by quoted surrounding text, not purely by line number.

---

### Task 1: `push_subscriptions` + `notification_log` migrations

**Files:**
- Create: `supabase/migrations/20260926050000_push_subscriptions.sql`
- Create: `supabase/migrations/20260926060000_notification_log.sql`

**Interfaces:**
- Produces: `public.push_subscriptions (id, owner_id, endpoint unique, p256dh, auth, created_at)`, `public.notification_log (id, kind, entity_id, sent_at, unique(kind, entity_id))` — consumed by Tasks 2, 4, 7.

- [ ] **Step 1: `push_subscriptions` migration**

```sql
-- push_subscriptions: a browser/device's Web Push endpoint. Deliberately does NOT follow this
-- app's usual "everyone reads" RLS convention (select using(true)) — an endpoint is effectively
-- a device secret (the ability to push a notification to someone's phone), not shared business
-- data, so only the owning user can see or delete their own rows. No admin override, unlike
-- every other table. No update policy: immutable, delete+recreate instead.
create table public.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);

create index push_subscriptions_owner_id_idx on public.push_subscriptions (owner_id);

alter table public.push_subscriptions enable row level security;

create policy "push_subscriptions_select" on public.push_subscriptions
  for select to authenticated using (owner_id = (select auth.uid()));
create policy "push_subscriptions_insert" on public.push_subscriptions
  for insert to authenticated with check (owner_id = (select auth.uid()));
create policy "push_subscriptions_delete" on public.push_subscriptions
  for delete to authenticated using (owner_id = (select auth.uid()));
```

- [ ] **Step 2: `notification_log` migration**

```sql
-- notification_log: dedup ledger for the cron notification job. kind + entity_id together
-- identify one (item, milestone) pair — the unique constraint is the entire dedup mechanism,
-- the sending job always tries an upsert with ignoreDuplicates before sending and only sends if
-- its own insert actually added a row. RLS enabled with ZERO policies, deliberately: this table
-- is written only by the cron job's service-role key (bypasses RLS entirely) and never read by
-- any client — zero policies denies every anon/authenticated request outright.
create table public.notification_log (
  id        uuid primary key default gen_random_uuid(),
  kind      text not null,
  entity_id uuid not null,
  sent_at   timestamptz not null default now(),
  unique (kind, entity_id)
);

alter table public.notification_log enable row level security;
```

- [ ] **Step 3: Reset and verify**

Run: `cd /Users/iddh/Workspaces/supabase && supabase db reset`
Expected: ends with `Finished supabase db reset on branch main.`, no error (both tables are brand new, nothing to backfill).

```bash
docker exec -i supabase_db_Workspaces psql -U postgres -c "\d public.push_subscriptions"
docker exec -i supabase_db_Workspaces psql -U postgres -c "\d public.notification_log"
```
Expected: `push_subscriptions` shows all 6 columns + 3 policies (select/insert/delete); `notification_log` shows 4 columns, the unique constraint, and RLS enabled with **no policies listed**.

- [ ] **Step 4: Commit**

```bash
cd /Users/iddh/Workspaces/supabase
git add migrations/20260926050000_push_subscriptions.sql migrations/20260926060000_notification_log.sql
git commit -m "feat: push_subscriptions + notification_log tables

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: SQL tests

**Files:**
- Create: `supabase/tests/notifications.test.sql`

**Interfaces:**
- Consumes: both tables from Task 1, the `pg_temp.as_user`/`pg_temp.expect` harness (copy verbatim from `supabase/tests/companies_contacts.test.sql`).

- [ ] **Step 1: Write the test file**

Create `supabase/tests/notifications.test.sql`:

```sql
-- supabase/tests/notifications.test.sql
-- Run: docker exec -i supabase_db_Workspaces psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/notifications.test.sql
begin;

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                        confirmation_token, recovery_token, email_change, email_change_token_new)
select '00000000-0000-0000-0000-000000000000', v.id, 'authenticated', 'authenticated', v.email, '', now(),
       '{}', '{}', now(), now(), '', '', '', ''
from (values
  ('eeeeeeee-2000-4000-8000-00000000000a'::uuid, 'test-admin4@example.test'),
  ('eeeeeeee-2000-4000-8000-00000000000b'::uuid, 'test-sales7@example.test'),
  ('eeeeeeee-2000-4000-8000-00000000000c'::uuid, 'test-sales8@example.test')
) as v(id, email);

update public.profiles set role = 'admin' where id = 'eeeeeeee-2000-4000-8000-00000000000a';

create function pg_temp.as_user(uid uuid, stmt text) returns text
language plpgsql as $$
declare
  n bigint;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    execute stmt;
    get diagnostics n = row_count;
    reset role;
    return 'ok:' || n;
  exception when others then
    reset role;
    return 'error:' || sqlerrm;
  end;
end
$$;

create function pg_temp.expect(name text, actual text, wanted text) returns void
language plpgsql as $$
begin
  if actual not like wanted then
    raise exception 'FAIL %: got "%", wanted like "%"', name, actual, wanted;
  end if;
  raise notice 'pass  %', name;
end
$$;

\set admin  '''eeeeeeee-2000-4000-8000-00000000000a'''
\set sales1 '''eeeeeeee-2000-4000-8000-00000000000b'''
\set sales2 '''eeeeeeee-2000-4000-8000-00000000000c'''

-- ── push_subscriptions: owner-only, no admin override (the one table in this app where that
-- matters — every other table lets admin edit/see everything) ──────────────────────────────────
select pg_temp.expect('sales1 subscribes (becomes owner)',
  pg_temp.as_user(:sales1, $$insert into public.push_subscriptions (endpoint, p256dh, auth, owner_id) values ('https://push.example.test/s1', 'p256dh-1', 'auth-1', 'eeeeeeee-2000-4000-8000-00000000000b')$$), 'ok:1');

select pg_temp.expect('sales1 sees their own subscription',
  pg_temp.as_user(:sales1, $$select 1 from public.push_subscriptions where endpoint = 'https://push.example.test/s1' having count(*) = 1$$), 'ok:1');

select pg_temp.expect('sales2 cannot see sales1''s subscription',
  pg_temp.as_user(:sales2, $$select 1 from public.push_subscriptions where endpoint = 'https://push.example.test/s1' having count(*) = 0$$), 'ok:1');

select pg_temp.expect('admin cannot see sales1''s subscription either — no admin override here',
  pg_temp.as_user(:admin, $$select 1 from public.push_subscriptions where endpoint = 'https://push.example.test/s1' having count(*) = 0$$), 'ok:1');

select pg_temp.expect('sales2 cannot delete sales1''s subscription',
  pg_temp.as_user(:sales2, $$delete from public.push_subscriptions where endpoint = 'https://push.example.test/s1'$$), 'ok:0');

select pg_temp.expect('admin cannot delete sales1''s subscription either',
  pg_temp.as_user(:admin, $$delete from public.push_subscriptions where endpoint = 'https://push.example.test/s1'$$), 'ok:0');

select pg_temp.expect('sales1 deletes their own subscription',
  pg_temp.as_user(:sales1, $$delete from public.push_subscriptions where endpoint = 'https://push.example.test/s1'$$), 'ok:1');

select pg_temp.expect('sales1 cannot insert a subscription owned by someone else',
  pg_temp.as_user(:sales1, $$insert into public.push_subscriptions (endpoint, p256dh, auth, owner_id) values ('https://push.example.test/s2', 'p', 'a', 'eeeeeeee-2000-4000-8000-00000000000c')$$), 'error:%row-level security%');

-- ── notification_log: zero policies — every authenticated attempt is denied ────────────────────
select pg_temp.expect('sales1 cannot select notification_log',
  pg_temp.as_user(:sales1, $$select 1 from public.notification_log having count(*) = 0$$), 'ok:1');

select pg_temp.expect('admin cannot insert into notification_log',
  pg_temp.as_user(:admin, $$insert into public.notification_log (kind, entity_id) values ('test_kind', 'eeeeeeee-2000-4000-8000-00000000000a')$$), 'error:%row-level security%');

do $$ begin raise notice 'ALL NOTIFICATIONS TESTS PASSED'; end $$;

rollback;
```

- [ ] **Step 2: Run it**

```bash
cd /Users/iddh/Workspaces/supabase
docker exec -i supabase_db_Workspaces psql -U postgres -v ON_ERROR_STOP=1 -f - < tests/notifications.test.sql
```
Expected: 9 `pass` NOTICEs, then `ALL NOTIFICATIONS TESTS PASSED`, then `ROLLBACK`. No `FAIL`/`ERROR`.

- [ ] **Step 3: Commit**

```bash
cd /Users/iddh/Workspaces/supabase
git add tests/notifications.test.sql
git commit -m "test: cover push_subscriptions owner-only RLS and notification_log lockout

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Zod schema

**Files:**
- Modify: `src/lib/schemas.ts` (ric-crm repo)

**Interfaces:**
- Produces: `pushSubscriptionCreate` — consumed by Task 4's API route.

- [ ] **Step 1: Add the schema**

Find `export const loginInput = z.object({` in `src/lib/schemas.ts` and insert immediately **before** it:

```typescript
export const pushSubscriptionCreate = z.object({
  endpoint: z.url().max(500),
  p256dh: text(200).min(1),
  auth: text(100).min(1),
  owner_id: z.uuid().optional(),
});

```

- [ ] **Step 2: Verify**

Run: `pnpm check`
Expected: `0 errors`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/schemas.ts
git commit -m "feat: pushSubscriptionCreate schema

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: VAPID public key wiring + API routes

**Files:**
- Modify: `astro.config.mjs`
- Modify: `src/pages/api/me.ts`
- Create: `src/pages/api/push-subscriptions.ts`

**Interfaces:**
- Consumes: `pushSubscriptionCreate` (Task 3).
- Produces: `GET /api/me` now also returns `vapidPublicKey`; `POST`/`DELETE /api/push-subscriptions` — consumed by Task 6's UI.

- [ ] **Step 1: Add the env var**

In `astro.config.mjs`, find:

```javascript
      // Service-role key: bypasses RLS. Only src/lib/supabase-admin.ts may read it, and only root-only routes may call that.
      SUPABASE_SECRET_KEY: envField.string({ context: 'server', access: 'secret', optional: true }),
    },
  },
});
```

Replace with:

```javascript
      // Service-role key: bypasses RLS. Only src/lib/supabase-admin.ts may read it, and only root-only routes may call that.
      SUPABASE_SECRET_KEY: envField.string({ context: 'server', access: 'secret', optional: true }),
      // Not actually secret (needed client-side for PushManager.subscribe), but read server-side
      // and handed to the client via /api/me's response — this app has no existing pattern for a
      // client-context public env var (the client never talks to Supabase directly, only through
      // this app's own /api/* routes), so this follows the same server-read-then-forward shape
      // instead of introducing one. The matching private key lives ONLY in cron-notifications/'s
      // own env — it never enters this app's codebase or runtime at all.
      VAPID_PUBLIC_KEY: envField.string({ context: 'server', access: 'secret', optional: true }),
    },
  },
});
```

- [ ] **Step 2: Expose it from `/api/me`**

Current content (`src/pages/api/me.ts`):

```typescript
import type { APIRoute } from 'astro';
import { json, fail, dbError } from '@/lib/api';

export const prerender = false;

/** Current user's profile plus the list of profiles (for owner pickers). */
export const GET: APIRoute = async ({ locals }) => {
  const { data, error } = await locals.supabase
    .from('profiles')
    .select('id, full_name, role')
    .order('full_name');
  if (error) return dbError(error);

  const me = data.find((p) => p.id === locals.user!.id);
  if (!me) return fail('Profile not found', 403);
  return json({ me, profiles: data });
};
```

Replace with:

```typescript
import type { APIRoute } from 'astro';
import { json, fail, dbError } from '@/lib/api';
import { VAPID_PUBLIC_KEY } from 'astro:env/server';

export const prerender = false;

/** Current user's profile, the list of profiles (for owner pickers), and the VAPID public key
 * (for push subscription — not secret, just has nowhere else to reach the client from). */
export const GET: APIRoute = async ({ locals }) => {
  const { data, error } = await locals.supabase
    .from('profiles')
    .select('id, full_name, role')
    .order('full_name');
  if (error) return dbError(error);

  const me = data.find((p) => p.id === locals.user!.id);
  if (!me) return fail('Profile not found', 403);
  return json({ me, profiles: data, vapidPublicKey: VAPID_PUBLIC_KEY || null });
};
```

- [ ] **Step 3: `src/pages/api/push-subscriptions.ts`**

```typescript
import type { APIRoute } from 'astro';
import { json, fail, parseBody, dbError } from '@/lib/api';
import { pushSubscriptionCreate } from '@/lib/schemas';

export const prerender = false;

export const POST: APIRoute = async ({ locals, request }) => {
  const body = await parseBody(request, pushSubscriptionCreate);
  if (body instanceof Response) return body;

  // Upsert on endpoint: a browser re-subscribing (e.g. after a service worker update) to the
  // same endpoint should update the row, not create a duplicate.
  const { data, error } = await locals.supabase
    .from('push_subscriptions')
    .upsert(body, { onConflict: 'endpoint' })
    .select('id')
    .single();
  if (error) return dbError(error);
  return json(data, 201);
};

export const DELETE: APIRoute = async ({ locals, url }) => {
  // Deleted by endpoint, not id: the client only reliably has the endpoint (from
  // PushManager.getSubscription()) at unsubscribe time, not a row id from an earlier page load.
  // RLS already restricts this to the caller's own rows — no requireRoot-style guard needed.
  const endpoint = url.searchParams.get('endpoint');
  if (!endpoint) return fail('Missing endpoint', 400);

  const { data, error } = await locals.supabase
    .from('push_subscriptions')
    .delete()
    .eq('endpoint', endpoint)
    .select('id');
  if (error) return dbError(error);
  if (data.length === 0) return fail('Not found', 404);
  return json({ ok: true });
};
```

- [ ] **Step 4: Verify**

Run: `pnpm check`
Expected: `0 errors`. (`astro:env/server`'s `VAPID_PUBLIC_KEY` won't be set in `.dev.vars` yet — that's fine, `envField`'s `optional: true` means it resolves to `undefined`/`null`, not a build error; Task 7 adds it locally.)

- [ ] **Step 5: Commit**

```bash
git add astro.config.mjs src/pages/api/me.ts src/pages/api/push-subscriptions.ts
git commit -m "feat: push-subscriptions API routes, VAPID public key via /api/me

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Service worker push handling

**Files:**
- Modify: `public/sw.js`

**Interfaces:**
- Consumes: the push payload shape `{ title, body, url }` sent by Task 7's cron Worker.

- [ ] **Step 1: Add the listeners**

Current content (`public/sw.js`, full file):

```javascript
// Minimal service worker: exists to satisfy "Add to Home Screen" installability criteria (Chrome/
// Android requires a registered service worker with a fetch handler before it will offer install),
// and as the foundation the push-notifications phase attaches a 'push' listener to later.
//
// Deliberately does NOT cache pages or API responses. This app shows live sales pipeline data —
// serving a stale cached version while "offline" would be actively misleading, not helpful, so
// there is no offline mode here, only pass-through.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
```

Replace with:

```javascript
// Minimal service worker: exists to satisfy "Add to Home Screen" installability criteria (Chrome/
// Android requires a registered service worker with a fetch handler before it will offer install),
// to receive Web Push events, and to handle a tap on a delivered notification.
//
// Deliberately does NOT cache pages or API responses. This app shows live sales pipeline data —
// serving a stale cached version while "offline" would be actively misleading, not helpful, so
// there is no offline mode here, only pass-through.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});

// Payload shape sent by the cron-notifications Worker: { title, body, url }.
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(self.registration.showNotification(data.title || 'RIC Sales CRM', {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data?.url || '/'));
});
```

- [ ] **Step 2: Verify**

Run: `node --check public/sw.js`
Expected: no output (syntax OK).

- [ ] **Step 3: Commit**

```bash
git add public/sw.js
git commit -m "feat: service worker push + notificationclick listeners

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Client UI — notification toggle

**Files:**
- Modify: `src/pages/index.astro` (sidebar markup near the logout form; JS: a new `vapidPublicKey` state var, `loadAll()`, and a new block of functions)

**Interfaces:**
- Consumes: `api()`, `esc()` — already defined; `who.vapidPublicKey` from Task 4's `/api/me`; `/api/push-subscriptions` (Task 4).
- Produces: `initNotifToggle()`, `onNotifToggleChange()` — no other task depends on these.

- [ ] **Step 1: Add the toggle markup**

Current content (`src/pages/index.astro`, sidebar bottom block):

```astro
  <!-- Bottom -->
  <div class="px-5 py-4 border-t border-white/5 space-y-3">
    <div>
      <p class="text-white text-xs font-medium truncate" id="me-name">—</p>
      <p class="text-white/40 text-[10px] uppercase tracking-wider" id="me-role"></p>
    </div>
    <form method="post" action="/api/auth/logout">
      <button type="submit" class="text-white/60 hover:text-white text-xs">ออกจากระบบ</button>
    </form>
    <p class="text-white/25 text-[10px] font-mono">Royal International Certification</p>
  </div>
```

Replace with:

```astro
  <!-- Bottom -->
  <div class="px-5 py-4 border-t border-white/5 space-y-3">
    <div>
      <p class="text-white text-xs font-medium truncate" id="me-name">—</p>
      <p class="text-white/40 text-[10px] uppercase tracking-wider" id="me-role"></p>
    </div>
    <div class="flex items-center gap-1.5" id="notif-toggle-wrap">
      <label class="flex items-center gap-1.5 text-white/60 hover:text-white text-xs cursor-pointer">
        <input type="checkbox" id="notif-toggle" onchange="onNotifToggleChange()" class="rounded-sm" />
        🔔 แจ้งเตือน
      </label>
      <span
        id="notif-ios-hint"
        class="hidden text-white/40 cursor-help text-xs"
        title="ต้องเพิ่มแอปนี้ลงหน้าจอโฮมก่อน ถึงจะเปิดการแจ้งเตือนได้ (กดปุ่มแชร์ในแถบด้านล่าง แล้วเลือก 'เพิ่มไปยังหน้าจอโฮม')"
      >?</span>
    </div>
    <form method="post" action="/api/auth/logout">
      <button type="submit" class="text-white/60 hover:text-white text-xs">ออกจากระบบ</button>
    </form>
    <p class="text-white/25 text-[10px] font-mono">Royal International Certification</p>
  </div>
```

- [ ] **Step 2: Add the `vapidPublicKey` state var**

Find `let me = null;` and add immediately after it:

```javascript
let vapidPublicKey = null;
```

- [ ] **Step 3: Wire `loadAll()`**

Current content (`src/pages/index.astro`, `loadAll()`):

```javascript
async function loadAll() {
  const [l, a, r, co, ct, na, who] = await Promise.all([
    api('/api/leads'),
    api('/api/activities'),
    api('/api/renewals'),
    api('/api/companies'),
    api('/api/contacts'),
    api('/api/next-actions'),
    api('/api/me'),
  ]);
  me = who.me;
  profiles = who.profiles;
  setupOwnerPickers();
  leads = l;
  activities = a;
  renewals = r;
  companies = co;
  contacts = ct;
```

Find the line right after this block's `contacts = ct;` that continues the function (do not remove anything else in the function — only insert two lines right after `contacts = ct;`):

```javascript
  contacts = ct;
  vapidPublicKey = who.vapidPublicKey;
  initNotifToggle();
```

- [ ] **Step 4: Add the notification functions**

Find `// ── Renewals ──` (the comment marking the start of the renewals section) and insert the following block immediately **before** it:

```javascript
// ── Push notifications ───────────────────────────────────────────────────
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

// iOS Safari only supports Web Push for a PWA already added to the Home Screen — requesting
// permission in a plain browser tab on iOS silently does nothing useful, so this is detected and
// the toggle is replaced with a disabled state + hover explanation instead of a broken prompt.
function isIosNotInstalled() {
  const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  return isIos && !isStandalone;
}

async function initNotifToggle() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !vapidPublicKey) {
    document.getElementById('notif-toggle-wrap').classList.add('hidden');
    return;
  }
  if (isIosNotInstalled()) {
    document.getElementById('notif-toggle').disabled = true;
    document.getElementById('notif-ios-hint').classList.remove('hidden');
    return;
  }
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  document.getElementById('notif-toggle').checked = !!existing;
}

async function onNotifToggleChange() {
  const checkbox = document.getElementById('notif-toggle');
  const registration = await navigator.serviceWorker.ready;

  if (checkbox.checked) {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      checkbox.checked = false;
      alert('ต้องอนุญาตการแจ้งเตือนในเบราว์เซอร์ก่อน');
      return;
    }
    try {
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      });
      const json = subscription.toJSON();
      await api('/api/push-subscriptions', {
        method: 'POST',
        body: JSON.stringify({ endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth }),
      });
    } catch (err) {
      checkbox.checked = false;
      alert('เปิดการแจ้งเตือนไม่สำเร็จ: ' + err.message);
    }
  } else {
    const existing = await registration.pushManager.getSubscription();
    if (existing) {
      const endpoint = existing.endpoint;
      await existing.unsubscribe();
      try {
        await api(`/api/push-subscriptions?endpoint=${encodeURIComponent(endpoint)}`, { method: 'DELETE' });
      } catch (err) {
        // Already unsubscribed client-side; a leftover server-side row is harmless — the cron
        // job prunes it automatically the next time a send to it 404s/410s.
      }
    }
  }
}
```

- [ ] **Step 5: Verify**

```bash
node -e "
const fs = require('fs');
const src = fs.readFileSync('src/pages/index.astro', 'utf8');
const start = src.indexOf('<script is:inline>') + '<script is:inline>'.length;
const end = src.indexOf('</script>', start);
fs.writeFileSync('/tmp/notif-check.js', src.slice(start, end));
"
node --check /tmp/notif-check.js
pnpm check
pnpm build
```
Expected: `node --check` produces no output; `pnpm check` reports `0 errors, 0 warnings`; `pnpm build` ends with `[build] Complete!`.

- [ ] **Step 6: Commit**

```bash
git add src/pages/index.astro
git commit -m "feat: notification toggle — subscribe/unsubscribe, iOS install-first detection

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: Cron Worker — scaffold + VAPID keys + core logic

**Files:**
- Create: `cron-notifications/package.json`
- Create: `cron-notifications/wrangler.toml`
- Create: `cron-notifications/tsconfig.json`
- Create: `cron-notifications/src/notifications.ts`
- Create: `cron-notifications/src/index.ts`
- Create: `cron-notifications/.gitignore`

**Interfaces:**
- Consumes: `public.next_actions`, `public.renewals`, `public.push_subscriptions`, `public.notification_log` (all already exist).
- Produces: `run(env)`, `findCandidates(supabase)`, `daysUntil(dateStr)` exported from `src/notifications.ts` — consumed by Task 8's test and Task 9's local verification.

This is a **new, standalone Cloudflare Worker** — its own directory, its own `package.json`/`wrangler.toml`, deployed independently of the main `ric-crm` site (Task 10). It is not part of the Astro build.

- [ ] **Step 1: `cron-notifications/package.json`**

```json
{
  "name": "ric-crm-cron-notifications",
  "type": "module",
  "private": true,
  "scripts": {
    "test": "tsx test/notifications.test.ts",
    "deploy": "wrangler deploy"
  },
  "dependencies": {
    "@supabase/supabase-js": "^2.116.0",
    "web-push": "^3.6.7"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20250924.0",
    "@types/web-push": "^3.6.4",
    "tsx": "^4.19.2",
    "typescript": "^6.0.3",
    "wrangler": "^4.135.0"
  }
}
```

- [ ] **Step 2: `cron-notifications/wrangler.toml`**

```toml
name = "ric-crm-notifications-cron"
main = "src/index.ts"
compatibility_date = "2026-09-01"
compatibility_flags = ["nodejs_compat"]

# Daily at 01:00 UTC (08:00 Bangkok time) — a reasonable "morning digest" time for a Thai sales team.
[triggers]
crons = ["0 1 * * *"]
```

- [ ] **Step 3: `cron-notifications/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "strict": true,
    "skipLibCheck": true,
    "types": ["@cloudflare/workers-types"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 4: `cron-notifications/.gitignore`**

```
node_modules/
.dev.vars
dist/
```

- [ ] **Step 5: `cron-notifications/src/notifications.ts`** — the pure logic, importable by the test in Task 8 without needing the Workers runtime

```typescript
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import webpush from 'web-push';

export interface NotificationEnv {
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
}

interface Candidate {
  kind: string;
  entityId: string;
  ownerId: string;
  title: string;
  body: string;
}

export function daysUntil(dateStr: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(dateStr);
  return Math.ceil((d.getTime() - today.getTime()) / 86400000);
}

export async function findCandidates(supabase: SupabaseClient): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  const today = new Date().toISOString().slice(0, 10);

  const { data: dueActions, error: naError } = await supabase
    .from('next_actions')
    .select('id, description, due_date, owner_id, lead:leads!lead_id(company:companies!company_id(name))')
    .is('completed_at', null)
    .not('due_date', 'is', null);
  if (naError) throw naError;

  for (const a of dueActions ?? []) {
    const company = (a as any).lead?.company?.name ?? '';
    if (a.due_date === today) {
      candidates.push({
        kind: 'next_action_due',
        entityId: a.id,
        ownerId: a.owner_id,
        title: 'งานถัดไปครบกำหนดวันนี้',
        body: `${company}: ${a.description}`,
      });
    } else if (a.due_date < today) {
      candidates.push({
        kind: 'next_action_overdue',
        entityId: a.id,
        ownerId: a.owner_id,
        title: 'งานถัดไปเลยกำหนดแล้ว',
        body: `${company}: ${a.description}`,
      });
    }
  }

  const { data: renewals, error: renError } = await supabase
    .from('renewals')
    .select('id, cert, audit_due, expiry, owner_id, company:companies!company_id(name)');
  if (renError) throw renError;

  for (const r of renewals ?? []) {
    const company = (r as any).company?.name ?? '';
    const auditDays = daysUntil(r.audit_due);
    const expiryDays = daysUntil(r.expiry);

    if (auditDays < 0) {
      candidates.push({
        kind: 'renewal_audit_overdue',
        entityId: r.id,
        ownerId: r.owner_id,
        title: 'เลยกำหนดตรวจใบรับรอง',
        body: `${company} — ${r.cert}`,
      });
    } else if (auditDays <= 30) {
      candidates.push({
        kind: 'renewal_audit_due',
        entityId: r.id,
        ownerId: r.owner_id,
        title: 'ใกล้ครบกำหนดตรวจใบรับรอง',
        body: `${company} — ${r.cert} (อีก ${auditDays} วัน)`,
      });
    }

    if (expiryDays < 0) {
      candidates.push({
        kind: 'renewal_expiry_overdue',
        entityId: r.id,
        ownerId: r.owner_id,
        title: 'ใบรับรองหมดอายุแล้ว',
        body: `${company} — ${r.cert}`,
      });
    } else if (expiryDays <= 30) {
      candidates.push({
        kind: 'renewal_expiry_due',
        entityId: r.id,
        ownerId: r.owner_id,
        title: 'ใบรับรองใกล้หมดอายุ',
        body: `${company} — ${r.cert} (อีก ${expiryDays} วัน)`,
      });
    }
  }

  return candidates;
}

export async function run(env: NotificationEnv): Promise<{ sent: number; skipped: number }> {
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
  webpush.setVapidDetails('mailto:support@ricroyal.co.th', env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);

  const candidates = await findCandidates(supabase);
  let sent = 0;
  let skipped = 0;

  for (const c of candidates) {
    // Upsert with ignoreDuplicates: the row comes back in `logged` only if THIS call inserted
    // it — a conflicting (already-logged) row is silently skipped and returns no row. That's
    // the entire dedup mechanism: only send when we're the one who just claimed this milestone.
    const { data: logged, error: logError } = await supabase
      .from('notification_log')
      .upsert({ kind: c.kind, entity_id: c.entityId }, { onConflict: 'kind,entity_id', ignoreDuplicates: true })
      .select();
    if (logError) throw logError;
    if (!logged || logged.length === 0) {
      skipped++;
      continue;
    }

    const { data: subs, error: subError } = await supabase
      .from('push_subscriptions')
      .select('id, endpoint, p256dh, auth')
      .eq('owner_id', c.ownerId);
    if (subError) throw subError;

    for (const sub of subs ?? []) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify({ title: c.title, body: c.body, url: '/' }),
        );
        sent++;
      } catch (err: any) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await supabase.from('push_subscriptions').delete().eq('id', sub.id);
        }
        // Any other failure (network blip, provider outage) is not retried this run — per the
        // spec's explicit out-of-scope note, it'll naturally resurface on the item's next
        // milestone, or never, if this was a one-time milestone already logged.
      }
    }
  }

  return { sent, skipped };
}
```

- [ ] **Step 6: `cron-notifications/src/index.ts`** — the thin Worker entrypoint

```typescript
import { run, type NotificationEnv } from './notifications';

export default {
  async scheduled(_event: ScheduledEvent, env: NotificationEnv, ctx: ExecutionContext) {
    ctx.waitUntil(run(env));
  },
};
```

- [ ] **Step 7: Install dependencies**

```bash
cd cron-notifications
pnpm install
```
Expected: installs cleanly, no errors.

- [ ] **Step 8: Generate VAPID keys (local crypto only — no network call, no deployment)**

```bash
cd cron-notifications
npx web-push generate-vapid-keys
```
Expected: prints a `Public Key` and a `Private Key`. Copy both — Step 9 needs them.

- [ ] **Step 9: Local dev secrets for both repos**

Create `cron-notifications/.dev.vars` (gitignored by Step 4's `.gitignore`):

```
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_SECRET_KEY=<the service_role key supabase status prints locally>
VAPID_PUBLIC_KEY=<public key from Step 8>
VAPID_PRIVATE_KEY=<private key from Step 8>
```

(`supabase status` in the `supabase` repo prints the local `service_role` key.)

Add the same `VAPID_PUBLIC_KEY` to the main app's `.dev.vars` (ric-crm repo root, already gitignored — do not commit it):

```
VAPID_PUBLIC_KEY=<the same public key from Step 8>
```

- [ ] **Step 10: Verify the worker compiles**

```bash
cd cron-notifications
npx tsc --noEmit
```
Expected: no output (no type errors).

- [ ] **Step 11: Commit**

```bash
cd /Users/iddh/Workspaces/ric-crm
git add cron-notifications/package.json cron-notifications/wrangler.toml cron-notifications/tsconfig.json cron-notifications/.gitignore cron-notifications/src/
git commit -m "feat: cron-notifications Worker — daily due-date push notification job

New standalone Cloudflare Worker (own package.json/wrangler.toml, not
part of the Astro build). Queries next_actions/renewals for items
crossing a due/overdue milestone, dedups via notification_log, sends
Web Push via VAPID. Not yet deployed — Task 10 handles that, gated on
explicit confirmation since it creates live production infrastructure.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

Note: `cron-notifications/pnpm-lock.yaml` (generated by Step 7) should be committed too — add it alongside the files above if `pnpm install` created one (it will).

---

### Task 8: Cron Worker test

**Files:**
- Create: `cron-notifications/test/notifications.test.ts`

**Interfaces:**
- Consumes: `run`, `findCandidates`, `daysUntil` from `src/notifications.ts` (Task 7).

- [ ] **Step 1: Write the test**

Create `cron-notifications/test/notifications.test.ts`:

```typescript
// Run: pnpm test (from cron-notifications/), against the LOCAL supabase stack (supabase start
// in the sibling supabase repo checkout first). Seeds one due next_action and one ≤30-day
// renewal for a throwaway lead/company, runs run() twice, and asserts: run 1 logs exactly the
// expected milestones and sends nothing (no push_subscriptions rows exist for the test owner,
// so `sent` is always 0 here — this test proves the dedup/query logic, not real delivery, which
// needs a real browser subscription this environment can't produce); run 2 logs nothing new.
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { run } from '../src/notifications';

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
if (!SUPABASE_SECRET_KEY) {
  console.error('SUPABASE_SECRET_KEY is required (see cron-notifications/.dev.vars, or export it before running)');
  process.exit(1);
}

const OWNER_ID = '00000000-0000-4000-8000-000000000001'; // root, from seed.sql — always present after a reset
const COMPANY_ID = '99999999-0000-4000-8000-000000000001';
const LEAD_ID = '99999999-0000-4000-8000-000000000002';
const NEXT_ACTION_ID = '99999999-0000-4000-8000-000000000003';
const RENEWAL_ID = '99999999-0000-4000-8000-000000000004';

async function main() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY!);

  // Clean slate for this test's fixture ids (safe to re-run).
  await supabase.from('notification_log').delete().in('entity_id', [NEXT_ACTION_ID, RENEWAL_ID]);
  await supabase.from('next_actions').delete().eq('id', NEXT_ACTION_ID);
  await supabase.from('renewals').delete().eq('id', RENEWAL_ID);
  await supabase.from('companies').delete().eq('id', COMPANY_ID);

  const { error: coErr } = await supabase.from('companies').insert({ id: COMPANY_ID, name: 'cron test co', owner_id: OWNER_ID });
  assert.equal(coErr, null, `company insert failed: ${coErr?.message}`);

  const { error: leadErr } = await supabase.from('leads').insert({ id: LEAD_ID, company_id: COMPANY_ID, stage: 'new', value: 0, notes: '', owner_id: OWNER_ID });
  assert.equal(leadErr, null, `lead insert failed: ${leadErr?.message}`);

  const today = new Date().toISOString().slice(0, 10);
  const { error: naErr } = await supabase.from('next_actions').insert({
    id: NEXT_ACTION_ID, lead_id: LEAD_ID, description: 'cron test action', due_date: today, owner_id: OWNER_ID,
  });
  assert.equal(naErr, null, `next_action insert failed: ${naErr?.message}`);

  const in13days = new Date(Date.now() + 13 * 86400000).toISOString().slice(0, 10);
  const in400days = new Date(Date.now() + 400 * 86400000).toISOString().slice(0, 10);
  const { error: renErr } = await supabase.from('renewals').insert({
    id: RENEWAL_ID, company_id: COMPANY_ID, cert: 'ISO 9001', audit_due: in13days, expiry: in400days, owner_id: OWNER_ID,
  });
  assert.equal(renErr, null, `renewal insert failed: ${renErr?.message}`);

  const env = {
    SUPABASE_URL,
    SUPABASE_SECRET_KEY: SUPABASE_SECRET_KEY!,
    VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY!,
    VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY!,
  };

  await run(env);

  const { data: afterRun1 } = await supabase
    .from('notification_log')
    .select('kind, entity_id')
    .in('entity_id', [NEXT_ACTION_ID, RENEWAL_ID]);
  const kinds = (afterRun1 ?? []).map((r) => r.kind).sort();
  assert.deepEqual(kinds, ['next_action_due', 'renewal_audit_due'], `unexpected milestones after run 1: ${JSON.stringify(kinds)}`);
  console.log('ok: run 1 logged exactly next_action_due + renewal_audit_due');

  await run(env);

  const { data: afterRun2 } = await supabase
    .from('notification_log')
    .select('kind, entity_id')
    .in('entity_id', [NEXT_ACTION_ID, RENEWAL_ID]);
  assert.equal(afterRun2?.length, 2, `run 2 should not add new rows, found ${afterRun2?.length}`);
  console.log('ok: run 2 added nothing new — dedup holds');

  // Cleanup.
  await supabase.from('notification_log').delete().in('entity_id', [NEXT_ACTION_ID, RENEWAL_ID]);
  await supabase.from('next_actions').delete().eq('id', NEXT_ACTION_ID);
  await supabase.from('renewals').delete().eq('id', RENEWAL_ID);
  await supabase.from('leads').delete().eq('id', LEAD_ID);
  await supabase.from('companies').delete().eq('id', COMPANY_ID);
  console.log('ok: test fixtures cleaned up');

  console.log('ALL CRON NOTIFICATION TESTS PASSED');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run it**

```bash
cd /Users/iddh/Workspaces/supabase && supabase status  # confirm local stack is running; supabase start if not
cd /Users/iddh/Workspaces/ric-crm/cron-notifications
set -a; source .dev.vars; set +a
pnpm test
```
Expected: `ok: run 1 logged exactly next_action_due + renewal_audit_due`, `ok: run 2 added nothing new — dedup holds`, `ok: test fixtures cleaned up`, `ALL CRON NOTIFICATION TESTS PASSED`. Exit code 0.

- [ ] **Step 3: Commit**

```bash
git add cron-notifications/test/
git commit -m "test: cron-notifications dedup logic against live local Supabase

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 9: End-to-end local verification

**Files:** none.

- [ ] **Step 1: Clean reset**

```bash
cd /Users/iddh/Workspaces/supabase && supabase db reset
```
Expected: ends with `Finished supabase db reset on branch main.`, no error.

- [ ] **Step 2: Confirm the dev server**

```bash
cd /Users/iddh/Workspaces/ric-crm
lsof -iTCP:4321 -sTCP:LISTEN || (pnpm dev > /tmp/dev.log 2>&1 &)
for i in $(seq 1 30); do curl -s -o /dev/null --max-time 2 http://localhost:4321/login && break; sleep 1; done
```

- [ ] **Step 3: Curl battery**

```bash
B=http://localhost:4321; H='Origin: http://localhost:4321'
JAR=$(mktemp)
curl -s -o /dev/null -w "login: %{http_code}\n" -c "$JAR" -H "$H" -X POST $B/api/auth/login \
  --data-urlencode 'email=root@ricroyal.co.th' --data-urlencode 'password=root!@Ric2026'

echo "-- /api/me now includes vapidPublicKey --"
curl -s -b "$JAR" $B/api/me | python3 -c "
import json, sys
me = json.load(sys.stdin)
assert 'vapidPublicKey' in me, me
print('ok:', 'set' if me['vapidPublicKey'] else 'null (VAPID_PUBLIC_KEY not in .dev.vars yet)')
"

echo "-- subscribe with a fake-but-well-formed subscription --"
SUB=$(curl -s -b "$JAR" -H "$H" -H 'content-type: application/json' -X POST $B/api/push-subscriptions -d '{"endpoint":"https://push.example.test/curl-test","p256dh":"test-p256dh","auth":"test-auth"}')
echo "$SUB"
echo "-- re-subscribing to the same endpoint upserts, not duplicates --"
curl -s -b "$JAR" -H "$H" -H 'content-type: application/json' -w " [%{http_code}]\n" -X POST $B/api/push-subscriptions -d '{"endpoint":"https://push.example.test/curl-test","p256dh":"changed","auth":"changed"}'

echo "-- unsubscribe --"
curl -s -b "$JAR" -H "$H" -w " [%{http_code}]\n" -X DELETE "$B/api/push-subscriptions?endpoint=https%3A%2F%2Fpush.example.test%2Fcurl-test"

echo "-- deleting again 404s (already gone) --"
curl -s -b "$JAR" -H "$H" -w " [%{http_code}]\n" -X DELETE "$B/api/push-subscriptions?endpoint=https%3A%2F%2Fpush.example.test%2Fcurl-test"
```
Expected: `vapidPublicKey` key present (value `set` if Task 7's `.dev.vars` step was done, `null` otherwise — both acceptable here); subscribe `[201]`; re-subscribe (upsert) `[201]`; unsubscribe `[200]`; second delete `[404]`.

- [ ] **Step 4: Build**

```bash
pnpm build
```
Expected: ends with `[build] Complete!`.

- [ ] **Step 5: Rendered-page markup check**

```bash
curl -s -b "$JAR" $B/ -o /tmp/notif-page.html
python3 -c "
content = open('/tmp/notif-page.html').read()
checks = {
  'toggle wrap': 'id=\"notif-toggle-wrap\"',
  'toggle input': 'id=\"notif-toggle\"',
  'ios hint': 'id=\"notif-ios-hint\"',
  'initNotifToggle fn': 'function initNotifToggle',
  'onNotifToggleChange fn': 'function onNotifToggleChange',
  'isIosNotInstalled fn': 'function isIosNotInstalled',
}
for label, needle in checks.items():
    print(f'{content.count(needle):>3}  {label}')
"
```
Expected: every row shows `1`.

- [ ] **Step 6: Cron Worker test (if not already run in Task 8)**

```bash
cd /Users/iddh/Workspaces/ric-crm/cron-notifications
set -a; source .dev.vars; set +a
pnpm test
```
Expected: `ALL CRON NOTIFICATION TESTS PASSED`.

- [ ] **Step 7: No commit** — this task makes no source changes.

## Known limitations (explicitly not built)

- No per-notification preferences — one toggle controls all notification kinds.
- No in-app notification history/inbox.
- No deep-linking to the specific lead/renewal — every notification opens the dashboard (`/`); this app has no per-record routes.
- No retry/backoff for a failed send — it is not retried this run.
- Real end-to-end delivery to an actual Android/iOS device cannot be verified by this plan's automated steps — Task 10 includes a manual device-testing checklist for after deployment.

---

### Task 10: Deploy — **STOP AND CONFIRM BEFORE RUNNING ANY COMMAND IN THIS TASK**

**Files:** none (infrastructure only).

**This task creates live production infrastructure**: a new public Cloudflare Worker, a Cron
Trigger that will run automatically on a schedule from then on, and production secrets
(including a private cryptographic key). Per this plan's Global Constraints, do not run any
command in this task without the human partner's explicit, specific go-ahead at this point —
completing Tasks 1-9 cleanly is not that go-ahead.

- [ ] **Step 1: Ask before proceeding**

Stop here. Confirm with the human partner that they want to deploy now, and which VAPID keypair
to use in production (Task 7's locally-generated keypair is fine to reuse, or a fresh pair can be
generated the same way — `npx web-push generate-vapid-keys` — if they'd rather keep production
and local dev keys separate).

- [ ] **Step 2: Set the main app's production secret**

```bash
cd /Users/iddh/Workspaces/ric-crm
npx wrangler secret put VAPID_PUBLIC_KEY
# paste the public key when prompted
```

- [ ] **Step 3: Deploy the main app**

```bash
pnpm deploy
```
Expected: ends with a successful deploy message and the live URL.

- [ ] **Step 4: Set the cron Worker's production secrets**

```bash
cd cron-notifications
npx wrangler secret put SUPABASE_URL
# the production Supabase project URL (see supabase/config.toml or the Supabase dashboard)
npx wrangler secret put SUPABASE_SECRET_KEY
# the PRODUCTION service_role key — from the Supabase dashboard, Settings → API. Never the local one.
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
```

- [ ] **Step 5: Deploy the cron Worker**

```bash
npx wrangler deploy
```
Expected: ends with a successful deploy message confirming the Cron Trigger schedule (`0 1 * * *`).

- [ ] **Step 6: Manual device verification checklist** (report back to the human partner, do not
  attempt to automate)

- Android/Chrome: open the deployed site, toggle notifications on, grant permission, confirm a
  `push_subscriptions` row appears (`select * from push_subscriptions` via the Supabase
  dashboard or CLI against production). Manually trigger the cron Worker once
  (`npx wrangler deploy` re-deploys don't fire it; use the Cloudflare dashboard's "Trigger Cron"
  button on the Worker's Triggers tab, or wait for the next scheduled run) against a lead/renewal
  known to be due, and confirm a real notification arrives on the device.
- iOS/Safari: open the deployed site in Safari, use the Share sheet → "Add to Home Screen",
  open the app from the home screen icon (not Safari), confirm the notification toggle is now
  enabled (not showing the "?" hint), toggle on, grant permission, repeat the same
  cron-trigger-and-confirm-delivery check.
- Confirm a re-run of the cron job (trigger it twice in a row) does not send a second
  notification for the same already-logged milestone.

- [ ] **Step 7: No commit** — this task is deployment/infrastructure only, no source changes
  (VAPID keys are set as Worker secrets, never committed to git).


