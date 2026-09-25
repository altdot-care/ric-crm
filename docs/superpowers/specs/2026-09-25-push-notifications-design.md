# Push Notifications Design

**Status:** Approved for planning
**Date:** 2026-09-25

## Problem

The app has two categories of time-sensitive items a salesperson or admin can silently miss
unless they happen to open the app: a lead's next-action (`next_actions`, already built — the
🔔 box on the Pipeline card) and a certificate renewal's audit/expiry dates (`renewals`, already
built — the two badges on the ใบรับรอง list). Both are currently pull-only: the user has to open
the app to see them. This adds push notifications so both surface on the user's phone (Android
and iOS) without opening the app first.

This is part 3 of 3 in the mobile/PWA work, after mobile-responsive layout (shipped) and PWA
installability (shipped, `manifest.json` + `/sw.js` + icons). iOS only supports Web Push for a
PWA that has already been added to the Home Screen (Safari, 16.4+) — installability was a hard
prerequisite for this part, which is why it shipped first.

## Goal

A user can opt in to notifications from within the app. Once opted in, they get exactly one push
per (item, milestone) — no repeated daily nagging for the same thing — covering:

- A `next_actions` item on its due date, and once more if it goes overdue.
- A `renewals` row's `audit_due` crossing into ≤30 days remaining, and once more if overdue.
- The same for `expiry`, independently of `audit_due`.

## Data model (supabase repo)

Two new tables. Both are new migrations following this repo's standing conventions (indexed FKs,
RLS enabled).

### `push_subscriptions`

```sql
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

**This deliberately breaks the project's established "everyone reads" RLS convention**
(`select using (true)`, used by every other table). A push subscription's `endpoint`/`p256dh`/
`auth` are device-identifying secrets — the ability to push a notification to someone's phone —
not shared business data like a lead or a company. `select` and `delete` are restricted to the
owning user only; there is no admin-or-root override, unlike every other table in this app. No
`update` policy: a subscription is immutable — the client deletes and re-creates instead of
editing one in place.

`on delete cascade` from `profiles` (not the `reassign_owner()` pattern used for every other
`owner_id` table): a push subscription is tied to one person's specific device/browser
installation. Reassigning it to a different user when the owner is deleted would silently start
notifying the wrong person; deleting it is correct, so no `reassign_owner()` extension is needed
here — a deliberate, reasoned exception to that pattern, not an oversight.

### `notification_log`

```sql
create table public.notification_log (
  id        uuid primary key default gen_random_uuid(),
  kind      text not null,
  entity_id uuid not null,
  sent_at   timestamptz not null default now(),
  unique (kind, entity_id)
);

alter table public.notification_log enable row level security;
-- No policies at all, deliberately: this table is written only by the sending job's
-- service-role key (which bypasses RLS entirely), and never read by any client. RLS enabled
-- with zero policies denies every anon/authenticated request outright.
```

`kind` is one of: `next_action_due`, `next_action_overdue`, `renewal_audit_due`,
`renewal_audit_overdue`, `renewal_expiry_due`, `renewal_expiry_overdue`. `entity_id` is the
`next_actions.id` or `renewals.id` the notification was about. The `unique (kind, entity_id)`
constraint is the entire dedup mechanism: the sending job always tries to `insert ... on
conflict do nothing` before sending, and only sends if the insert actually added a row.

## Sending mechanism: a second, standalone Cloudflare Worker

The Astro Cloudflare adapter (`@astrojs/cloudflare`) owns the main Worker's fetch handling and
does not cleanly support adding a `scheduled` (Cron Trigger) export alongside it. Rather than
fight the adapter, this adds a **second, independent Worker** — its own directory
(`cron/` at the repo root), its own minimal `wrangler.toml` with a daily Cron Trigger, its own
`package.json`, deployed separately from the main site (`wrangler deploy` run from `cron/`,
documented as a second deploy step).

The cron Worker:
1. Connects to Supabase with the **service-role key** (a Worker secret, bypassing RLS — the same
   trust model this app already uses for `reassign_owner()` and other root-only backend calls).
2. Queries `next_actions` (open items, i.e. `completed_at is null`) and `renewals` for items
   crossing a milestone today (due today / newly overdue for next_actions; newly ≤30 days or
   newly overdow for renewals' `audit_due` and `expiry` independently).
3. For each candidate, `insert into notification_log ... on conflict (kind, entity_id) do
   nothing`. If the insert added a row (checked via the returned row), the milestone hasn't
   fired before — send it. If not, skip.
4. For each item to send, looks up the item's `owner_id`, fetches that owner's rows from
   `push_subscriptions`, and sends a Web Push message to each (a user may have multiple
   subscriptions — e.g. phone and desktop).
5. Uses the `web-push` npm package for VAPID-signed payload delivery (RFC 8291 encryption + JWT
   auth) — this repo's `nodejs_compat` compatibility flag is already enabled, which covers the
   package's Node `crypto` dependency in the Workers runtime.
6. A push that fails with 404/410 (the subscription is gone — user revoked permission, browser
   data cleared) deletes that `push_subscriptions` row, so dead endpoints don't accumulate.

VAPID keys (one public/private pair for the whole app) are generated once (`web-push` ships a
`generate-vapid-keys` CLI) and stored as Worker secrets (`VAPID_PRIVATE_KEY` for the cron Worker;
`VAPID_PUBLIC_KEY` is not secret — needed client-side too, so it's baked into the main app's
client bundle via `astro:env`'s public-context, the same way other non-secret config would be).

## Client-side subscribe/unsubscribe

A new "🔔 เปิดการแจ้งเตือน" toggle (location: near the user's name/logout in the sidebar footer,
visible only once `me` is loaded — this is a single-tenant-per-browser toggle, not per-view).

- **On, supported browser:** `Notification.requestPermission()` → on grant,
  `navigator.serviceWorker.ready` → `registration.pushManager.subscribe({ userVisibleOnly: true,
  applicationServerKey: VAPID_PUBLIC_KEY })` → `POST /api/push-subscriptions` with the
  subscription's `endpoint`/`keys.p256dh`/`keys.auth`.
- **Off:** `pushManager.getSubscription()` → `unsubscribe()` client-side, then
  `DELETE /api/push-subscriptions/:id` (looked up by endpoint, or the client keeps the row id
  from the subscribe response).
- **iOS Safari, not installed as a PWA:** detected via `navigator.standalone === undefined &&
  /iPhone|iPad|iPod/.test(navigator.userAgent) && !window.matchMedia('(display-mode:
  standalone)').matches`. The toggle is replaced by a disabled state with a small "?" icon next
  to it; hovering (native `title` attribute, same pattern already used on the ใบรับรอง list)
  shows "ต้องเพิ่มแอปนี้ลงหน้าจอโฮมก่อน ถึงจะเปิดการแจ้งเตือนได้ (กดปุ่มแชร์ในแถบด้านล่าง แล้วเลือก
  'เพิ่มไปยังหน้าจอโฮม')" (must add to Home Screen first; how to, via Safari's Share sheet). No
  permission request is attempted in this state — it would silently fail.

## API routes (ric-crm repo)

- `POST /api/push-subscriptions` — body `{ endpoint, p256dh, auth }` (validated by a new
  `pushSubscriptionCreate` Zod schema), `owner_id` from the session (same pattern as every other
  create route). Upserts on `endpoint` (a browser re-subscribing to the same endpoint after, say,
  a service worker update should not create a duplicate row).
- `DELETE /api/push-subscriptions/:id` — owner-only (RLS enforces this; the route itself doesn't
  need a `requireRoot`-style guard since the policy already restricts to `owner_id = auth.uid()`
  and there's no root override to bypass here).

## Service worker (`public/sw.js`)

Two new listeners added to the existing minimal worker (which still caches nothing):

```js
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

The cron Worker's push payload is `{ title, body, url }` — `url` lets a renewal notification deep
link to `/` (this app has no per-record routes; opening the dashboard is the best available
target, noted as a real limitation below rather than over-engineered around).

## Testing

- New `supabase/tests/push_subscriptions.test.sql`: RLS matrix proving the "owner-only, no admin
  override" shape specifically (select/insert/delete own succeed; select/delete someone else's
  fail) — this is the one table in the app where that matters to get right, since it's the one
  table where the usual "admin sees everything" assumption does NOT hold.
- `notification_log`'s zero-policy lockout is tested by confirming `authenticated` gets `ok:0`/
  RLS errors on select/insert attempts.
- The cron Worker gets its own lightweight test: a script that seeds one due next_action and one
  ≤30-day renewal, runs the Worker's handler function directly (not via an actual Cron Trigger
  firing), and asserts exactly one `notification_log` row per milestone and zero duplicate sends
  on a second run.
- `pnpm check` / `pnpm build` in ric-crm as usual.
- Manual verification: this feature's true end-to-end behavior (a real push arriving on a real
  Android/iOS device) cannot be curl-tested — the plan's final verification step documents the
  manual device-testing checklist instead of claiming automated coverage it can't have.

## Out of scope

- No per-notification user preferences (e.g., "only notify me about my own leads' next-actions,
  not renewals") — one on/off toggle controls everything in this pass.
- No notification history/inbox inside the app — a push either arrives on the device or it
  doesn't; there's no in-app log of past notifications to review.
- No deep-linking to the specific lead/renewal a notification is about — this app has no
  per-record URLs (everything is client-side view state in one page), so every notification
  opens the dashboard. Adding real routing is a much larger change and not part of this pass.
- No notifications for the event-driven triggers considered during brainstorming (new activity
  note, stage change by someone else) — explicitly deferred, cron-based due-date reminders only.
- No retry/backoff for a temporarily-failing push send (network blip, provider outage) — a failed
  send this run is simply not retried; it'll naturally resurface on the next milestone that item
  crosses, or never, if it was a one-time milestone already logged. Acceptable at this scale.
