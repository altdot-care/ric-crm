# Follow-up Time + /preview Test Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a follow-up in the deal Log carry a time and notify at that time, and give root a `/preview` page whose buttons test the real push pipeline.

**Architecture:** `activities` gains `followup_time` (Bangkok wall-clock). The Cron Worker runs every 5 minutes; every candidate has a "may start sending at" minute (follow-up time, else 08:00) and only fires once Bangkok time has reached it. The Worker also gets a `fetch` handler (`/preview/test-push`, `/preview/dry-run`) guarded by a shared `NOTIFIER_SECRET`; the web app's root-only `/api/preview/*` routes call it, so the VAPID private key never leaves the Worker.

**Tech Stack:** Astro 7 on Cloudflare Workers, Supabase (Postgres + RLS), zod 4, `web-push`, `node:test` (`--experimental-strip-types`), Playwright, pnpm workspace (`ric-crm` + `cron-notifications`), sibling repo `../supabase` (migrations + SQL tests).

**Spec:** `docs/superpowers/specs/2026-09-25-followup-time-and-preview-design.md`

## Global Constraints

- All times are **Bangkok wall-clock** (UTC+7). `followup_time` is a Postgres `time` without time zone. Postgres returns it as `"14:30:00"`; inputs and the API use `"HH:MM"`.
- Default send time for anything without its own time is **08:00 Bangkok** (`480` minutes).
- Cron schedule becomes `*/5 * * * *`. Dedup stays `notification_log (kind, entity_id)`; `kind` for follow-ups stays `followup_due`.
- `/preview` and `/api/preview/*` are **root only**, checked server-side from the database (`requireRoot` / profile query), never from the client.
- The web app never holds `VAPID_PRIVATE_KEY`. Preview calls the Worker with `Authorization: Bearer <NOTIFIER_SECRET>`.
- Worker preview responses: unknown path/method → 404; secret unset → 503; missing/wrong secret → 401. Test-push message text is fixed (no caller-supplied text); target is always the signed-in root's own `ownerId` from the session.
- Preview endpoints never write `notification_log`. Dry-run never calls `send`.
- Never print `NOTIFIER_SECRET` or any key to the terminal. Real `.dev.vars` files are gitignored; never commit them.
- Tests must use LOCAL Supabase only (existing tests assert this) and must never send a real push (`send` is injected).
- Copy is Thai. Buttons ≥ 44px tall; nothing overflows at 320px.
- Commits: local only (nothing is pushed). Each commit message ends with `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.
- zsh note for executors: `docker exec` wrappers must be shell functions, and `sed -i` needs `-i ''` on macOS — prefer the Edit tool.

## Review Focus

1. **Midnight boundary:** a follow-up at `00:00` Bangkok on the day, and the 16:59Z→17:00Z day rollover (pinned in Task 4 unit test).
2. **Time format mismatch:** Postgres returns `14:30:00`, `<input type="time">` uses `14:30` (pinned in Tasks 3 and 4).
3. **Wrong / unset / malformed secret** on the Worker must never yield 200 (pinned in Task 5).
4. **Preview must not write `notification_log` or reach other users** (pinned in Task 5, integration).
5. **A non-root opening `/preview` or calling `/api/preview/*` directly** (pinned in Task 8, browser).

## File Structure

| File | Responsibility |
|---|---|
| `../supabase/migrations/20260926090000_activities_followup_time.sql` | `followup_time` column + check |
| `../supabase/tests/activities_followup_time.test.sql` | DB behavior of the column |
| `src/lib/schemas.ts` | `followup_time` in `activityCreate`/`activityUpdate` |
| `src/pages/api/activities.ts`, `src/pages/api/activities/[id].ts` | write `followup_time` |
| `src/pages/index.astro` | Log form time input, display, nav link to `/preview` |
| `cron-notifications/src/notifications.ts` | time helpers, gating in `findCandidates`, extracted `deliver()`, exported types |
| `cron-notifications/src/preview.ts` (new) | `handlePreview` — auth, `test-push`, `dry-run` |
| `cron-notifications/src/index.ts` | add `fetch` handler |
| `cron-notifications/wrangler.toml` | cron `*/5 * * * *` |
| `cron-notifications/scripts/notifier-env.mjs` (new), `setup-notifier.mjs` (new), `setup-local.mjs` | generate/append `NOTIFIER_*` in `.dev.vars` files |
| `astro.config.mjs`, `.dev.vars.example` (both) | declare/document `NOTIFIER_URL`, `NOTIFIER_SECRET` |
| `src/lib/notifier.ts` (new) | `callNotifier`, `notifierResponse` |
| `src/pages/api/preview/{test-push,dry-run,subscriptions}.ts` (new) | root-only preview API |
| `src/pages/preview.astro`, `public/preview.js` (new) | the page and its client script |
| `tests/…`, `tests/browser/preview.spec.ts` (new) | tests per task |
| `docs/mobile-push-handoff.md`, `README.md` | docs |

---

### Task 0: Checkpoint — commit the pending earlier work

The working trees already hold finished, verified work from earlier requests (certificates tab, certificate link, Log edit/delete + next-actions removal, squashed migrations follow-ups). Committing it first keeps later commits small and reviewable. **Requires the user's go-ahead (they have not yet said to commit).**

**Files:** none created.

- [ ] **Step 1: Ask the user for permission to commit the pending work; stop here if they decline (then later commits must use `git commit <paths>` and accept that `index.astro` mixes changes).**

- [ ] **Step 2: Commit `supabase` pending work**

```bash
cd /Users/iddh/Workspaces/supabase
git add -A migrations tests seed.sql
git commit -m "feat: drop next_actions, let owners edit/delete log entries" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
git status --short
```
Expected: no output from `git status --short`.

- [ ] **Step 3: Commit `ric-crm` pending work**

```bash
cd /Users/iddh/Workspaces/ric-crm
git add -A .
git status --short   # confirm no .dev.vars, test-results/, node_modules/ or dist/
git commit -m "feat: company certificates tab, certificate link, editable log, drop next actions" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
git status --short
```
Expected: no output. If `.dev.vars` or `test-results/` appear in the first `git status`, stop and fix `.gitignore` before committing.

---

### Task 1: DB — `activities.followup_time`

**Files:**
- Create: `../supabase/migrations/20260926090000_activities_followup_time.sql`
- Create: `../supabase/tests/activities_followup_time.test.sql`

**Interfaces:**
- Produces: column `public.activities.followup_time time null`; constraint `activities_followup_time_requires_date` (time only with a date). Later tasks select/insert `followup_time`.

- [ ] **Step 1: Write the failing SQL test**

Create `../supabase/tests/activities_followup_time.test.sql`:

```sql
-- supabase/tests/activities_followup_time.test.sql
-- activities.followup_time: optional Bangkok wall-clock time for a follow-up; only valid with a date.
-- Run: docker exec -i supabase_db_Workspaces psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/activities_followup_time.test.sql
begin;

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                        confirmation_token, recovery_token, email_change, email_change_token_new)
values ('00000000-0000-0000-0000-000000000000', 'eeeeeeee-5000-4000-8000-00000000000a', 'authenticated',
        'authenticated', 'test-followup-time@example.test', '', now(), '{}', '{}', now(), now(), '', '', '', '');

insert into public.companies (id, name, owner_id)
values ('eeeeeeee-5000-4000-8000-0000000000c1', 'Followup Time Co', 'eeeeeeee-5000-4000-8000-00000000000a');
insert into public.leads (id, company_id, owner_id)
values ('eeeeeeee-5000-4000-8000-0000000000e1', 'eeeeeeee-5000-4000-8000-0000000000c1', 'eeeeeeee-5000-4000-8000-00000000000a');

insert into public.activities (id, lead_id, type, description, followup, followup_time, owner_id) values
  ('eeeeeeee-5000-4000-8000-0000000000d1', 'eeeeeeee-5000-4000-8000-0000000000e1', 'call', 'timed', '2026-09-30', '14:30', 'eeeeeeee-5000-4000-8000-00000000000a'),
  ('eeeeeeee-5000-4000-8000-0000000000d2', 'eeeeeeee-5000-4000-8000-0000000000e1', 'call', 'date only', '2026-09-30', null, 'eeeeeeee-5000-4000-8000-00000000000a'),
  ('eeeeeeee-5000-4000-8000-0000000000d3', 'eeeeeeee-5000-4000-8000-0000000000e1', 'note', 'no followup', null, null, 'eeeeeeee-5000-4000-8000-00000000000a');

do $$
begin
  if (select followup_time::text from public.activities where id = 'eeeeeeee-5000-4000-8000-0000000000d1') is distinct from '14:30:00' then
    raise exception 'FAIL: time was not stored';
  end if;
  if (select followup_time from public.activities where id = 'eeeeeeee-5000-4000-8000-0000000000d2') is not null then
    raise exception 'FAIL: date-only follow-up should have no time';
  end if;
  raise notice 'pass  stores a time, and time is optional';

  begin
    insert into public.activities (lead_id, type, description, followup, followup_time, owner_id)
    values ('eeeeeeee-5000-4000-8000-0000000000e1', 'note', 'bad', null, '09:00', 'eeeeeeee-5000-4000-8000-00000000000a');
    raise exception 'FAIL: time without a date was accepted';
  exception when check_violation then
    raise notice 'pass  rejects a time without a date';
  end;

  begin
    update public.activities set followup = null where id = 'eeeeeeee-5000-4000-8000-0000000000d1';
    raise exception 'FAIL: clearing the date left the time behind';
  exception when check_violation then
    raise notice 'pass  rejects clearing the date while a time is set';
  end;

  update public.activities set followup = null, followup_time = null where id = 'eeeeeeee-5000-4000-8000-0000000000d1';
  raise notice 'pass  clearing both together works';
  raise notice 'ALL FOLLOWUP TIME TESTS PASSED';
end $$;

rollback;
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /Users/iddh/Workspaces
docker exec -i supabase_db_Workspaces psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/activities_followup_time.test.sql 2>&1 | grep -E "ERROR|PASSED" | head -3
```
Expected: `ERROR:  column "followup_time" of relation "activities" does not exist`.

- [ ] **Step 3: Write the migration**

Create `../supabase/migrations/20260926090000_activities_followup_time.sql`:

```sql
-- activities.followup_time: optional time-of-day (Bangkok wall-clock, like the date it accompanies)
-- for a follow-up reminder. Without it, the reminder goes out at the default 08:00 as before.
-- A time only makes sense together with a date, so the database enforces that too.
alter table public.activities
  add column followup_time time null,
  add constraint activities_followup_time_requires_date
    check (followup_time is null or followup is not null);
```

- [ ] **Step 4: Apply locally and run every SQL test**

```bash
cd /Users/iddh/Workspaces/supabase && supabase migration up --local 2>&1 | tail -2
cd .. && for t in supabase/tests/*.test.sql; do printf "%-42s" $(basename $t); docker exec -i supabase_db_Workspaces psql -U postgres -d postgres -v ON_ERROR_STOP=1 < $t 2>&1 | grep -E "PASSED|ERROR|FAIL" | head -1; done
```
Expected: `Migrations applied`, then seven lines each ending `PASSED` (including `ALL FOLLOWUP TIME TESTS PASSED`).

- [ ] **Step 5: Commit**

```bash
cd /Users/iddh/Workspaces/supabase
git add migrations/20260926090000_activities_followup_time.sql tests/activities_followup_time.test.sql
git commit -m "feat: activities.followup_time (optional, requires followup date)" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Schema + API accept `followup_time`

**Files:**
- Modify: `src/lib/schemas.ts` (the `activityFollowup` / `activityCreate` / `activityUpdate` block)
- Modify: `src/pages/api/activities.ts` (POST)
- Modify: `src/pages/api/activities/[id].ts` (PUT)
- Test: `tests/followup-time.test.mjs` (create)

**Interfaces:**
- Consumes: column from Task 1.
- Produces: request bodies may include `followup_time: "HH:MM" | ""`; `""` means clear. Rows returned by the API include `followup_time` as `"HH:MM:SS"` or `null` (from `select *`).

- [ ] **Step 1: Write the failing test**

Create `tests/followup-time.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { activityCreate, activityUpdate } from '../src/lib/schemas.ts';

const lead_id = '11111111-1111-4111-8111-111111111111';
const create = extra => activityCreate.safeParse({ lead_id, description: 'x', ...extra });
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('a follow-up may carry a time in HH:MM', () => {
  const parsed = activityCreate.parse({ lead_id, description: 'x', followup: '2026-10-01', followup_time: '14:30' });
  assert.equal(parsed.followup_time, '14:30');
  assert.equal(create({ followup: '2026-10-01', followup_time: '00:00' }).success, true);
  assert.equal(create({ followup: '2026-10-01', followup_time: '23:59' }).success, true);
});

test('a follow-up time may be empty (no time chosen)', () => {
  assert.equal(create({ followup: '2026-10-01', followup_time: '' }).success, true);
  assert.equal(create({}).success, true);
});

test('malformed follow-up times are rejected', () => {
  for (const bad of ['24:00', '9:30', '12:60', '14:30:00', '14.30', 'noon']) {
    assert.equal(create({ followup: '2026-10-01', followup_time: bad }).success, false, bad);
  }
});

test('a time needs a date in the same request when creating', () => {
  assert.equal(create({ followup_time: '09:00' }).success, false);
  assert.equal(create({ followup: '', followup_time: '09:00' }).success, false);
});

test('update: a time cannot ride along with a cleared date, but may be sent alone', () => {
  assert.equal(activityUpdate.safeParse({ followup: '', followup_time: '09:00' }).success, false);
  assert.equal(activityUpdate.safeParse({ followup_time: '09:00' }).success, true);
  assert.equal(activityUpdate.safeParse({ followup: '2026-10-01', followup_time: '' }).success, true);
});

test('routes write followup_time and clear it when the date is cleared', () => {
  const post = read('../src/pages/api/activities.ts');
  const put = read('../src/pages/api/activities/[id].ts');
  assert.match(post, /followup_time/);
  assert.match(put, /followup_time/);
  assert.match(put, /followup === ''\s*\?\s*\{\s*followup_time:\s*null\s*\}/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --experimental-strip-types --test tests/followup-time.test.mjs 2>&1 | grep -E "^(✔|✖)|ℹ (pass|fail)"`
Expected: several `✖` (e.g. "a follow-up may carry a time" fails — the key is stripped so `followup_time` is `undefined`), `ℹ fail` > 0.

- [ ] **Step 3: Implement the schema**

In `src/lib/schemas.ts`, replace the block from `const activityType = ...` through `activityUpdate` with:

```ts
const activityType = z.enum(['call', 'email', 'meeting', 'note']);
const activityFollowup = z.union([isoDate, z.literal('')]).optional();
// Bangkok wall-clock "HH:MM" ("" = no time). The database stores it as a Postgres time.
const activityFollowupTime = z.union([z.literal(''), z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)]).optional();

export const activityCreate = z.object({
  lead_id: z.uuid(),
  type: activityType.default('note'),
  description: text(5000).min(1),
  date: isoDate.optional(),
  followup: activityFollowup,
  followup_time: activityFollowupTime,
  owner_id: z.uuid().optional(),
}).refine(d => !d.followup_time || !!d.followup, {
  message: 'followup_time requires followup',
  path: ['followup_time'],
});
// An entry stays on its deal and with its owner: only what the salesperson wrote can change.
export const activityUpdate = z.object({
  type: activityType.optional(),
  description: text(5000).min(1).optional(),
  followup: activityFollowup,
  followup_time: activityFollowupTime,
}).refine(d => !d.followup_time || d.followup !== '', {
  message: 'followup_time cannot accompany a cleared followup',
  path: ['followup_time'],
});
```
(Keep the existing two comment lines above `activityType` about `stage_change`.)

- [ ] **Step 4: Implement the routes**

`src/pages/api/activities.ts` — in `POST`, replace the destructure and insert with:

```ts
  const { followup, followup_time, date, ...rest } = body;
  const { data, error } = await locals.supabase
    .from('activities')
    .insert({
      ...rest,
      ...(date && { date }),
      followup: followup || null,
      // A time is only ever stored together with its date.
      followup_time: followup ? followup_time || null : null,
    })
    .select(COLUMNS)
    .single();
```

`src/pages/api/activities/[id].ts` — in `PUT`, replace the destructure and update with:

```ts
  const { followup, followup_time, ...rest } = body;
  const patch = {
    ...rest,
    ...(followup !== undefined && { followup: followup || null }),
    // Clearing the date must clear the time (the database forbids a time without a date).
    ...(followup === '' ? { followup_time: null } : followup_time !== undefined && { followup_time: followup_time || null }),
  };
  const { data, error } = await locals.supabase
    .from('activities')
    .update(patch)
    .eq('id', id.data)
    .select(COLUMNS);
```

- [ ] **Step 5: Run tests and typecheck**

```bash
node --experimental-strip-types --test tests/followup-time.test.mjs tests/activity-edit.test.mjs 2>&1 | grep -E "^✖|ℹ (pass|fail)"
pnpm check 2>&1 | grep -E "error|Result"
```
Expected: `ℹ fail 0` and `0 errors`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/schemas.ts src/pages/api/activities.ts "src/pages/api/activities/[id].ts" tests/followup-time.test.mjs
git commit -m "feat: activities API accepts followup_time" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Log tab — time input and display

**Files:**
- Modify: `src/pages/index.astro` (Log form markup ~line 420, `saveLeadActivity`, `editLeadActivity`, `cancelLeadActivityEdit`, the two `a.followup` display lines)
- Test: `tests/followup-time.test.mjs` (append), `tests/browser/mobile.spec.ts` (append)

**Interfaces:**
- Consumes: API from Task 2 (`followup_time` in request/response).
- Produces: `followupLabel(a)` global — `"2026-12-25 14:30"` or `"2026-12-25"`; `syncFollowupTime()` global.

- [ ] **Step 1: Append the failing static test**

Append to `tests/followup-time.test.mjs`:

```js
test('Log form has a time input tied to the follow-up date, and entries show the time', () => {
  const html = read('../src/pages/index.astro');
  assert.match(html, /id="lead-act-followup-time"[^>]*type="time"|type="time"[^>]*id="lead-act-followup-time"/);
  assert.match(html, /function syncFollowupTime/);
  assert.match(html, /function followupLabel/);
  assert.match(html, /followup_time: document\.getElementById\('lead-act-followup-time'\)\.value/);
  assert.equal((html.match(/esc\(followupLabel\(a\)\)/g) || []).length, 2, 'both the feed and the Log tab use followupLabel');
  assert.doesNotMatch(html, /นัดติดตาม: \$\{esc\(a\.followup\)\}/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --experimental-strip-types --test tests/followup-time.test.mjs 2>&1 | grep -E "✖|ℹ fail"`
Expected: the new test fails.

- [ ] **Step 3: Implement**

In `src/pages/index.astro`:

(a) Replace `<input class="field-input" id="lead-act-followup" type="date" />` with:

```html
          <div class="flex gap-2">
            <input class="field-input min-w-0 flex-1" id="lead-act-followup" type="date" aria-label="วันนัดติดตาม" oninput="syncFollowupTime()" />
            <input class="field-input w-28 shrink-0" id="lead-act-followup-time" type="time" aria-label="เวลานัดติดตาม" disabled />
          </div>
```

(b) In the script, add next to `renderLeadLog` (before it):

```js
// "2026-12-25 14:30" — Postgres hands the time back as "14:30:00", so trim the seconds.
function followupLabel(a) {
  return a.followup_time ? `${a.followup} ${a.followup_time.slice(0, 5)}` : a.followup;
}

// The time only makes sense with a date: disable it (and drop any value) while the date is empty.
function syncFollowupTime() {
  const time = document.getElementById('lead-act-followup-time');
  const hasDate = !!document.getElementById('lead-act-followup').value;
  time.disabled = !hasDate;
  if (!hasDate) time.value = '';
}
```

(c) Replace both occurrences of `${esc(a.followup)}` inside the `🔔 นัดติดตาม:` lines with `${esc(followupLabel(a))}`.

(d) In `saveLeadActivity`, add to the `data` object after `followup`:

```js
    followup_time: document.getElementById('lead-act-followup-time').value,
```

(e) In `editLeadActivity`, after `document.getElementById('lead-act-followup').value = entry.followup || '';` add:

```js
  syncFollowupTime();
  document.getElementById('lead-act-followup-time').value = (entry.followup_time || '').slice(0, 5);
```

(f) In `cancelLeadActivityEdit`, right after `document.getElementById('lead-act-form').reset();` add `syncFollowupTime();`.

- [ ] **Step 4: Append the browser test**

Append to `tests/browser/mobile.spec.ts`:

```ts
test('follow-up time is saved with the date, shown in the Log, and needs a date', async ({ page }) => {
  await page.evaluate(id => (window as any).openLeadModal(id), lead);
  await page.locator('#lead-tab-btn-log').click();
  await expect(page.locator('#lead-act-followup-time')).toBeDisabled();

  await page.locator('#lead-act-description').fill('โทรกลับลูกค้า');
  await page.locator('#lead-act-followup').fill('2026-12-25');
  await expect(page.locator('#lead-act-followup-time')).toBeEnabled();
  await page.locator('#lead-act-followup-time').fill('14:30');
  await page.locator('#lead-act-submit').click();
  await expect(page.locator('#lead-log-list')).toContainText('2026-12-25 14:30');
  const stored = () => db.from('activities').select('followup, followup_time').eq('lead_id', lead).eq('description', 'โทรกลับลูกค้า').single();
  expect((await stored()).data).toEqual({ followup: '2026-12-25', followup_time: '14:30:00' });

  const entry = page.locator('#lead-log-list > div', { hasText: 'โทรกลับลูกค้า' });
  await entry.getByRole('button', { name: 'แก้ไขบันทึก' }).click();
  await expect(page.locator('#lead-act-followup-time')).toHaveValue('14:30');
  await page.locator('#lead-act-followup').fill('');
  await expect(page.locator('#lead-act-followup-time')).toBeDisabled();
  await expect(page.locator('#lead-act-followup-time')).toHaveValue('');
  await page.locator('#lead-act-submit').click();
  await expect(page.locator('#lead-log-list')).not.toContainText('2026-12-25');
  expect((await stored()).data).toEqual({ followup: null, followup_time: null });
});
```

- [ ] **Step 5: Run everything relevant**

```bash
node --experimental-strip-types --test tests/*.test.mjs 2>&1 | grep -E "^✖|ℹ (pass|fail)"
pnpm check 2>&1 | grep -E "error|Result"
curl -s -o /dev/null -w "dev server: %{http_code}\n" localhost:4321/
pnpm exec playwright test 2>&1 | tail -5
```
Expected: `ℹ fail 0`, `0 errors`, dev server `302` (if `500`/no answer, ask the user to restart their dev server — it is their process), Playwright all passed.

- [ ] **Step 6: Commit**

```bash
git add src/pages/index.astro tests/followup-time.test.mjs tests/browser/mobile.spec.ts
git commit -m "feat: follow-up time input and display in the deal Log" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Cron — time-based sending, every 5 minutes

**Files:**
- Modify: `cron-notifications/src/notifications.ts` (helpers, `findCandidates`)
- Modify: `cron-notifications/wrangler.toml`
- Test: `cron-notifications/test/notifications.test.ts`

**Interfaces:**
- Consumes: `activities.followup_time` (Task 1).
- Produces (exported from `notifications.ts`):
  - `DEFAULT_SEND_MINUTE = 480`
  - `bangkokMinutes(now: Date): number` — minutes since Bangkok midnight
  - `followupStartMinute(time: string | null): number` — `"14:30"`/`"14:30:00"` → 870, `null` → 480
  - `findCandidates(db, now)` now returns only items whose start minute ≤ current Bangkok minute; certificates only from 08:00.

- [ ] **Step 1: Write the failing unit test for the helpers**

Append to `cron-notifications/test/notifications.test.ts`:

```ts
test('Bangkok minute-of-day and follow-up start minute, including the midnight boundary', async () => {
  const m = await import('../src/notifications.ts');
  assert.equal(m.DEFAULT_SEND_MINUTE, 480);
  assert.equal(m.bangkokMinutes(new Date('2026-09-25T17:00:00Z')), 0, '17:00Z is 00:00 Bangkok');
  assert.equal(m.bangkokMinutes(new Date('2026-09-25T16:59:00Z')), 23 * 60 + 59);
  assert.equal(m.bangkokMinutes(new Date('2026-09-26T01:00:00Z')), 480);
  assert.equal(m.followupStartMinute(null), 480);
  assert.equal(m.followupStartMinute('14:30:00'), 870, 'Postgres time has seconds');
  assert.equal(m.followupStartMinute('14:30'), 870, 'input time does not');
  assert.equal(m.followupStartMinute('00:00:00'), 0, 'a midnight follow-up starts at minute 0, not the 08:00 default');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd cron-notifications && pnpm test 2>&1 | grep -E "^(✔|✖)|ℹ (pass|fail)"`
Expected: the new test fails (`m.bangkokMinutes is not a function`).

- [ ] **Step 3: Implement the helpers and gating**

In `cron-notifications/src/notifications.ts`, below `bangkokDate`, add:

```ts
/** Anything without its own time (certificates, follow-ups with no time) goes out at 08:00 Bangkok. */
export const DEFAULT_SEND_MINUTE = 8 * 60;

/** Minutes since midnight in Bangkok. */
export function bangkokMinutes(now: Date): number {
  const bangkok = new Date(now.getTime() + 7 * 3600000);
  return bangkok.getUTCHours() * 60 + bangkok.getUTCMinutes();
}

/** Minute of the day a follow-up may start sending. `time` is "HH:MM" or Postgres "HH:MM:SS". */
export function followupStartMinute(time: string | null): number {
  if (!time) return DEFAULT_SEND_MINUTE;
  const [hours, minutes] = time.split(':');
  return Number(hours) * 60 + Number(minutes);
}
```

Replace the follow-up query/loop in `findCandidates` with (and add `const nowMinute = bangkokMinutes(now);` right after `const today = bangkokDate(now);`):

```ts
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await db.from('activities')
      .select('id, description, followup_time, owner_id, lead:leads!lead_id(company:companies!company_id(name))')
      .eq('followup', today).order('id').range(offset, offset + 499);
    if (error) throw error;
    for (const activity of data ?? []) {
      if (followupStartMinute(activity.followup_time) > nowMinute) continue; // not time yet — a later run sends it
      const lead = activity.lead as unknown as { company: { name: string } | null } | null;
      const time = activity.followup_time ? activity.followup_time.slice(0, 5) : null;
      candidates.push({
        kind: 'followup_due', entityId: activity.id, ownerId: activity.owner_id,
        title: time ? `ถึงเวลานัดติดตาม ${time}` : 'ถึงวันนัดติดตามวันนี้',
        body: `${lead?.company?.name || ''}: ${activity.description}`,
      });
    }
    if (!data || data.length < 500) break;
  }
  // Certificates are a morning digest: nothing before 08:00 Bangkok.
  if (nowMinute < DEFAULT_SEND_MINUTE) return candidates;
```
(The `const cutoff = …` renewals loop stays after this.)

In `cron-notifications/wrangler.toml` replace the comment + cron line with:

```toml
# Every 5 minutes: follow-ups with a time go out within 5 minutes of it; everything else waits for
# 08:00 Bangkok (the code enforces that — the schedule only sets how often we look).
[triggers]
crons = ["*/5 * * * *"]
```

- [ ] **Step 4: Update the integration test for time gating**

In `cron-notifications/test/notifications.test.ts`, in the test `local database: candidates, opt-in, …` make these exact edits:

1. `const now = new Date('2026-09-25T18:00:00Z'); // Sep 26 in Bangkok` → `const now = new Date('2026-09-26T02:00:00Z'); // 09:00 on Sep 26 in Bangkok`
2. `const due = randomUUID(), past = randomUUID(), renewal = randomUUID();` → `const due = randomUUID(), past = randomUUID(), timed = randomUUID(), renewal = randomUUID();`
3. In the `activities` insert array add these two rows after the `future` row:
```ts
      { id: timed, lead_id: lead, type: 'call', description: 'timed earlier today', followup: '2026-09-26', followup_time: '08:30', owner_id: owner },
      { id: randomUUID(), lead_id: lead, type: 'call', description: 'timed later today', followup: '2026-09-26', followup_time: '09:30', owner_id: owner },
```
4. Expected kinds: `['followup_due', 'renewal_audit_due', 'renewal_expiry_overdue']` → `['followup_due', 'followup_due', 'renewal_audit_due', 'renewal_expiry_overdue']`
5. Both `[due, past, renewal]` → `[due, past, timed, renewal]`
6. `assert.equal(sent.length, 3, …)` (three occurrences) → `4`; `assert.equal((await logs()).data?.length, 3);` → `4`; `assert.equal((await logs()).data?.length, 5);` → `6`.
7. Immediately before the line `const candidates = await findCandidates(scoped, now);` insert:
```ts
    const before8 = await findCandidates(scoped, new Date('2026-09-26T00:59:00Z')); // 07:59 Bangkok
    assert.deepEqual(before8.map(c => c.kind), [], 'nothing (follow-ups or certificates) before 08:00 Bangkok');
    const at8 = await findCandidates(scoped, new Date('2026-09-26T01:00:00Z')); // 08:00 Bangkok
    assert.deepEqual(at8.map(c => c.kind).sort(), ['followup_due', 'renewal_audit_due', 'renewal_expiry_overdue'],
      'at 08:00 the untimed follow-up and certificates go; the 08:30 and 09:30 ones do not yet');
```

- [ ] **Step 5: Run cron tests and typecheck**

Run: `cd cron-notifications && pnpm test 2>&1 | grep -E "^(✔|✖)|ℹ (pass|fail)" && pnpm check 2>&1 | tail -2`
Expected: 4 tests pass (`ℹ pass 4`), `tsc --noEmit` prints nothing after the `$ tsc` line.

- [ ] **Step 6: Commit**

```bash
cd /Users/iddh/Workspaces/ric-crm
git add cron-notifications/src/notifications.ts cron-notifications/test/notifications.test.ts cron-notifications/wrangler.toml
git commit -m "feat: cron sends follow-ups at their time (every 5 min), certificates from 08:00" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Worker preview endpoints (`test-push`, `dry-run`)

**Files:**
- Modify: `cron-notifications/src/notifications.ts` (extract `deliver`, export types, `NOTIFIER_SECRET?`)
- Create: `cron-notifications/src/preview.ts`
- Modify: `cron-notifications/src/index.ts`
- Test: `cron-notifications/test/preview.test.ts` (create)

**Interfaces:**
- Consumes: `findCandidates`, `sendPush`, `isPushEndpoint` (existing).
- Produces:
  - `notifications.ts`: `export type SendFn`, `export interface Subscription`, `export interface Candidate`, `export async function deliver(db, send, subscriptions, payload): Promise<{ sent: number; failed: number; pruned: number }>`; `NotificationEnv.NOTIFIER_SECRET?: string`.
  - `preview.ts`: `handlePreview(request: Request, env: NotificationEnv, deps?: { db?: SupabaseClient; send?: SendFn; now?: Date }): Promise<Response>`.
  - HTTP: `POST /preview/test-push` body `{ ownerId }` → `{ devices, sent, failed, pruned }`; `POST /preview/dry-run` body `{}` → `{ now: "YYYY-MM-DD HH:MM", candidates: [{ kind, title, body, ownerId, alreadySent }] }` (max 200).

- [ ] **Step 1: Refactor — extract `deliver()` (no behavior change)**

In `notifications.ts`: change `interface Candidate` → `export interface Candidate`, `interface Subscription` → `export interface Subscription`, add `NOTIFIER_SECRET?: string;` to `NotificationEnv`, and add:

```ts
export type SendFn = (subscription: Subscription, payload: string) => Promise<number>;

/** Send one payload to each subscription, pruning ones the push service says are gone. */
export async function deliver(
  db: SupabaseClient, send: SendFn,
  subscriptions: { id: string; endpoint: string; p256dh: string; auth: string }[], payload: string,
) {
  let sent = 0, failed = 0, pruned = 0;
  for (const sub of subscriptions) {
    try {
      const code = await send({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
      if (code >= 200 && code < 300) sent++;
      else {
        failed++;
        if (code === 404 || code === 410) {
          const { error } = await db.from('push_subscriptions').delete().eq('id', sub.id);
          if (error) console.warn('Unable to prune expired push subscription');
          else pruned++;
        }
      }
    } catch {
      failed++;
      // Deliberately no retry: milestone remains claimed, as documented in the spec.
      // Do not log endpoints, keys, payloads or provider error bodies.
    }
  }
  return { sent, failed, pruned };
}
```
Change `RunOptions.send` to `send?: SendFn;` and in `run()` replace the whole `for (const sub of valid) { … }` block with:

```ts
    const result = await deliver(db, send, valid, JSON.stringify({ title: candidate.title, body: candidate.body, url: '/' }));
    sent += result.sent; failed += result.failed; pruned += result.pruned;
```
Run: `cd cron-notifications && pnpm test 2>&1 | grep -E "ℹ (pass|fail)"` → `ℹ pass 4`, `ℹ fail 0` (behavior unchanged).

- [ ] **Step 2: Write the failing preview tests**

Create `cron-notifications/test/preview.test.ts`:

```ts
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
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd cron-notifications && node --experimental-strip-types --test test/preview.test.ts 2>&1 | grep -E "Cannot find|ERR_MODULE|✖|ℹ fail" | head -3`
Expected: fails to load — `Cannot find module '../src/preview.ts'`.

- [ ] **Step 4: Implement `preview.ts`**

Create `cron-notifications/src/preview.ts`:

```ts
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { timingSafeEqual } from 'node:crypto';
import { isPushEndpoint } from '../../src/lib/push-endpoint.ts';
import { deliver, findCandidates, sendPush, type NotificationEnv, type SendFn } from './notifications.ts';

interface PreviewDeps { db?: SupabaseClient; send?: SendFn; now?: Date }

const ROUTES = new Set(['/preview/test-push', '/preview/dry-run']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reply = (data: unknown, status = 200) => Response.json(data, { status });

/** Constant-time comparison: hash both sides so lengths match and timing reveals nothing. */
async function sameSecret(given: string, expected: string): Promise<boolean> {
  const digest = async (value: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return timingSafeEqual(await digest(given), await digest(expected));
}

/**
 * Root-only test tools, called by the web app with a shared secret. Neither route writes
 * notification_log; test-push always uses fixed text and only the ownerId it is given.
 */
export async function handlePreview(request: Request, env: NotificationEnv, deps: PreviewDeps = {}): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (request.method !== 'POST' || !ROUTES.has(path)) return reply({ error: 'Not found' }, 404);
  if (!env.NOTIFIER_SECRET) return reply({ error: 'Preview endpoints are not configured' }, 503);
  const bearer = /^Bearer (.+)$/.exec(request.headers.get('Authorization') ?? '');
  if (!bearer || !(await sameSecret(bearer[1], env.NOTIFIER_SECRET))) return reply({ error: 'Unauthorized' }, 401);

  try {
    const db = deps.db ?? createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    return path === '/preview/test-push'
      ? await testPush(request, env, db, deps.send)
      : await dryRun(db, deps.now ?? new Date());
  } catch (error) {
    console.error('Preview failed:', error instanceof Error ? error.message : 'unknown error');
    return reply({ error: 'Internal error' }, 500);
  }
}

async function testPush(request: Request, env: NotificationEnv, db: SupabaseClient, send?: SendFn): Promise<Response> {
  let body: { ownerId?: unknown };
  try { body = await request.json(); } catch { return reply({ error: 'Invalid JSON body' }, 400); }
  if (typeof body.ownerId !== 'string' || !UUID.test(body.ownerId)) return reply({ error: 'ownerId must be a uuid' }, 400);

  const { data, error } = await db.from('push_subscriptions').select('id, endpoint, p256dh, auth').eq('owner_id', body.ownerId);
  if (error) throw error;
  const valid = (data ?? []).filter(sub => isPushEndpoint(sub.endpoint));
  const payload = JSON.stringify({ title: 'ทดสอบการแจ้งเตือน', body: 'ถ้าเห็นข้อความนี้ แสดงว่าระบบแจ้งเตือนทำงานปกติ', url: '/' });
  const result = await deliver(db, send ?? ((sub, text) => sendPush(env, sub, text)), valid, payload);
  return reply({ devices: valid.length, ...result });
}

async function dryRun(db: SupabaseClient, now: Date): Promise<Response> {
  const shown = (await findCandidates(db, now)).slice(0, 200);
  const logged = new Set<string>();
  if (shown.length) {
    const { data, error } = await db.from('notification_log').select('kind, entity_id').in('entity_id', shown.map(c => c.entityId));
    if (error) throw error;
    for (const row of data ?? []) logged.add(`${row.kind}:${row.entity_id}`);
  }
  return reply({
    now: new Date(now.getTime() + 7 * 3600000).toISOString().slice(0, 16).replace('T', ' '),
    candidates: shown.map(c => ({ kind: c.kind, title: c.title, body: c.body, ownerId: c.ownerId, alreadySent: logged.has(`${c.kind}:${c.entityId}`) })),
  });
}
```

In `cron-notifications/src/index.ts` replace the file with:

```ts
import { run, type NotificationEnv } from './notifications.ts';
import { handlePreview } from './preview.ts';

export default {
  async scheduled(event: ScheduledEvent, env: NotificationEnv, ctx: ExecutionContext) {
    ctx.waitUntil(run(env, { now: new Date(event.scheduledTime) }).then(result => {
      console.log('Notification run:', JSON.stringify(result));
    }));
  },
  // Root-only test tools for the web app's /preview page; see preview.ts.
  async fetch(request: Request, env: NotificationEnv) {
    return handlePreview(request, env);
  },
};
```

- [ ] **Step 5: Run cron tests and typecheck**

Run: `cd cron-notifications && pnpm test 2>&1 | grep -E "^(✔|✖)|ℹ (pass|fail)" && pnpm check 2>&1 | tail -2`
Expected: `ℹ pass 9` (4 existing + 5 new), `ℹ fail 0`, `tsc` clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/iddh/Workspaces/ric-crm
git add cron-notifications/src cron-notifications/test/preview.test.ts
git commit -m "feat: Worker preview endpoints (test-push, dry-run) behind a shared secret" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: `NOTIFIER_*` configuration and `.dev.vars`

**Files:**
- Create: `cron-notifications/scripts/notifier-env.mjs`, `cron-notifications/scripts/setup-notifier.mjs`
- Modify: `cron-notifications/scripts/setup-local.mjs`, `astro.config.mjs`, `.dev.vars.example`, `cron-notifications/.dev.vars.example`
- Modify (gitignored, not committed): `.dev.vars`, `cron-notifications/.dev.vars`
- Test: `tests/notifier-env.test.mjs` (create)

**Interfaces:**
- Produces: `ensureNotifierEnv({ appPath, workerPath, url? }): { changed: string[] }` in `notifier-env.mjs`. Idempotent; the same 64-hex-char `NOTIFIER_SECRET` ends up in both files; `NOTIFIER_URL` (default `http://localhost:8787`) only in the app file; never prints a secret; throws if the two files hold different secrets; throws if the worker file is missing.
- Produces: env names `NOTIFIER_URL`, `NOTIFIER_SECRET` (optional, `secret` access) in the Astro schema.

- [ ] **Step 1: Write the failing test**

Create `tests/notifier-env.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureNotifierEnv } from '../cron-notifications/scripts/notifier-env.mjs';

const fixture = (app, worker) => {
  const dir = mkdtempSync(join(tmpdir(), 'notifier-env-'));
  const appPath = join(dir, 'app.vars'), workerPath = join(dir, 'worker.vars');
  writeFileSync(appPath, app, { mode: 0o600 });
  if (worker !== null) writeFileSync(workerPath, worker, { mode: 0o600 });
  return { appPath, workerPath };
};
const value = (text, key) => text.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1];

test('adds the same random secret to both files and the URL to the app file, keeping existing lines', () => {
  const paths = fixture('SUPABASE_URL=http://127.0.0.1:54321\nVAPID_PUBLIC_KEY=abc\n', 'VAPID_PRIVATE_KEY=xyz\n');
  const { changed } = ensureNotifierEnv(paths);
  assert.deepEqual(changed.sort(), [paths.appPath, paths.workerPath].sort());
  const app = readFileSync(paths.appPath, 'utf8'), worker = readFileSync(paths.workerPath, 'utf8');
  assert.match(value(app, 'NOTIFIER_SECRET'), /^[0-9a-f]{64}$/);
  assert.equal(value(app, 'NOTIFIER_SECRET'), value(worker, 'NOTIFIER_SECRET'));
  assert.equal(value(app, 'NOTIFIER_URL'), 'http://localhost:8787');
  assert.equal(value(worker, 'NOTIFIER_URL'), undefined);
  assert.match(app, /SUPABASE_URL=http:\/\/127\.0\.0\.1:54321\nVAPID_PUBLIC_KEY=abc\n/);
  assert.match(worker, /^VAPID_PRIVATE_KEY=xyz\n/);
});

test('is idempotent: a second run changes nothing and keeps the secret', () => {
  const paths = fixture('A=1\n', 'B=2\n');
  ensureNotifierEnv(paths);
  const before = readFileSync(paths.appPath, 'utf8');
  assert.deepEqual(ensureNotifierEnv(paths).changed, []);
  assert.equal(readFileSync(paths.appPath, 'utf8'), before);
});

test('reuses a secret that already exists in one of the files', () => {
  const paths = fixture('A=1\n', `NOTIFIER_SECRET=${'a'.repeat(64)}\n`);
  ensureNotifierEnv(paths);
  assert.equal(value(readFileSync(paths.appPath, 'utf8'), 'NOTIFIER_SECRET'), 'a'.repeat(64));
});

test('refuses to overwrite two different secrets, and needs the worker file to exist', () => {
  assert.throws(() => ensureNotifierEnv(fixture(`NOTIFIER_SECRET=${'a'.repeat(64)}\n`, `NOTIFIER_SECRET=${'b'.repeat(64)}\n`)), /different/i);
  assert.throws(() => ensureNotifierEnv(fixture('A=1\n', null)), /setup-local/);
});

test('keeps files private (0600) and handles a file with no trailing newline', () => {
  const paths = fixture('A=1', 'B=2');
  ensureNotifierEnv(paths);
  assert.equal(statSync(paths.appPath).mode & 0o777, 0o600);
  assert.match(readFileSync(paths.appPath, 'utf8'), /^A=1\nNOTIFIER_SECRET=/);
});

test('astro declares both variables and both .example files document them', () => {
  const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
  const astro = read('../astro.config.mjs');
  assert.match(astro, /NOTIFIER_URL:\s*envField\.string\(\{ context: 'server', access: 'secret', optional: true \}\)/);
  assert.match(astro, /NOTIFIER_SECRET:\s*envField\.string\(\{ context: 'server', access: 'secret', optional: true \}\)/);
  assert.match(read('../.dev.vars.example'), /^NOTIFIER_URL=/m);
  assert.match(read('../.dev.vars.example'), /^NOTIFIER_SECRET=/m);
  assert.match(read('../cron-notifications/.dev.vars.example'), /^NOTIFIER_SECRET=/m);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --experimental-strip-types --test tests/notifier-env.test.mjs 2>&1 | grep -E "Cannot find|ℹ fail"`
Expected: `Cannot find module …/notifier-env.mjs`.

- [ ] **Step 3: Implement the helper and scripts**

Create `cron-notifications/scripts/notifier-env.mjs`:

```js
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const read = path => readFileSync(path, 'utf8');
const get = (text, key) => text.match(new RegExp(`^${key}=(.+)$`, 'm'))?.[1];
const append = (text, lines) => `${text}${text && !text.endsWith('\n') ? '\n' : ''}${lines.join('\n')}\n`;

/**
 * Makes sure both .dev.vars files carry the same NOTIFIER_SECRET (web app ↔ Cron Worker) and the
 * app file knows where the Worker listens. Idempotent; never prints the secret.
 * Returns the paths it changed.
 */
export function ensureNotifierEnv({ appPath, workerPath, url = 'http://localhost:8787' }) {
  if (!existsSync(workerPath)) throw new Error('cron-notifications/.dev.vars is missing — run setup-local.mjs first');
  const app = existsSync(appPath) ? read(appPath) : '';
  const worker = read(workerPath);
  const inApp = get(app, 'NOTIFIER_SECRET'), inWorker = get(worker, 'NOTIFIER_SECRET');
  if (inApp && inWorker && inApp !== inWorker) throw new Error('NOTIFIER_SECRET is different in the two .dev.vars files — fix by hand');
  const secret = inApp || inWorker || randomBytes(32).toString('hex');

  const changed = [];
  const write = (path, text) => { writeFileSync(path, text, { mode: 0o600 }); chmodSync(path, 0o600); changed.push(path); };
  const appAdds = [];
  if (!inApp) appAdds.push(`NOTIFIER_SECRET=${secret}`);
  if (!get(app, 'NOTIFIER_URL')) appAdds.push(`NOTIFIER_URL=${url}`);
  if (appAdds.length) write(appPath, append(app, appAdds));
  if (!inWorker) write(workerPath, append(worker, [`NOTIFIER_SECRET=${secret}`]));
  return { changed };
}
```

Create `cron-notifications/scripts/setup-notifier.mjs`:

```js
import { ensureNotifierEnv } from './notifier-env.mjs';

const { changed } = ensureNotifierEnv({
  appPath: new URL('../../.dev.vars', import.meta.url).pathname,
  workerPath: new URL('../.dev.vars', import.meta.url).pathname,
});
console.log(changed.length ? `Updated (secret not shown): ${changed.join(', ')}` : 'NOTIFIER_* already configured — nothing changed.');
console.log('Restart `pnpm dev` (web) and the Worker so they pick up the new variables.');
```

In `cron-notifications/scripts/setup-local.mjs`, add at the top `import { ensureNotifierEnv } from './notifier-env.mjs';` and, immediately before the final `console.log(...)`, add:

```js
ensureNotifierEnv({ appPath: appPath.pathname, workerPath: workerPath.pathname });
```

- [ ] **Step 4: Declare and document the variables**

`astro.config.mjs` — after the `VAPID_PUBLIC_KEY` line add:

```js
      // /preview → Cron Worker (test push, dry-run). Optional: preview reports "not configured" without them.
      NOTIFIER_URL: envField.string({ context: 'server', access: 'secret', optional: true }),
      NOTIFIER_SECRET: envField.string({ context: 'server', access: 'secret', optional: true }),
```

Append to `.dev.vars.example`:

```
# /preview (root only) calls the Cron Worker with a shared secret. Generate both with:
#   node cron-notifications/scripts/setup-notifier.mjs
NOTIFIER_URL=http://localhost:8787
NOTIFIER_SECRET=<same value as cron-notifications/.dev.vars>
```

Append to `cron-notifications/.dev.vars.example`:

```
NOTIFIER_SECRET=<same value as the web app's .dev.vars — protects /preview/* on this Worker>
```

- [ ] **Step 5: Run the test, then configure the real local files**

```bash
node --experimental-strip-types --test tests/notifier-env.test.mjs 2>&1 | grep -E "^(✔|✖)|ℹ (pass|fail)"
node cron-notifications/scripts/setup-notifier.mjs
grep -c "^NOTIFIER_SECRET=" .dev.vars cron-notifications/.dev.vars; grep -c "^NOTIFIER_URL=" .dev.vars
git status --short | grep -i "dev.vars" | grep -v example
```
Expected: `ℹ pass 6`; the script prints only file paths ("secret not shown"); each `grep -c` prints `…:1`; the last command prints nothing (real `.dev.vars` files stay untracked/ignored). **Never `cat` these files.**

- [ ] **Step 6: Commit (example files, config, scripts, test only)**

```bash
pnpm check 2>&1 | grep -E "error|Result"
git add astro.config.mjs .dev.vars.example cron-notifications/.dev.vars.example cron-notifications/scripts tests/notifier-env.test.mjs
git commit -m "feat: NOTIFIER_URL/NOTIFIER_SECRET config and setup script" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: Web API — `/api/preview/*`

**Files:**
- Create: `src/lib/notifier.ts`
- Create: `src/pages/api/preview/test-push.ts`, `dry-run.ts`, `subscriptions.ts`
- Test: `tests/notifier.test.mjs` (create)

**Interfaces:**
- Consumes: Worker HTTP contract (Task 5); env vars (Task 6); `requireRoot` from `@/lib/auth`.
- Produces:
  - `callNotifier(path: '/preview/test-push' | '/preview/dry-run', body: unknown, config: { url?: string; secret?: string; fetchImpl?: typeof fetch }): Promise<{ ok: true; data: unknown } | { ok: false; status: number; error: string }>`
  - `notifierResponse(result): Response` (ok → 200 JSON of `data`; not ok → `{ error }` with `status`).
  - `POST /api/preview/test-push` → Worker result; `POST /api/preview/dry-run` → Worker result; `GET /api/preview/subscriptions` → `[{ id, host, created_at }]` (root's own devices only). All 403 for non-root.

- [ ] **Step 1: Write the failing test**

Create `tests/notifier.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callNotifier, notifierResponse } from '../src/lib/notifier.ts';

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
  assert.equal(seen.init.redirect, 'error');
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --experimental-strip-types --test tests/notifier.test.mjs 2>&1 | grep -E "Cannot find|ℹ fail"`
Expected: `Cannot find module '../src/lib/notifier.ts'`.

- [ ] **Step 3: Implement**

Create `src/lib/notifier.ts`:

```ts
import { json, fail } from './api.ts';

export type NotifierPath = '/preview/test-push' | '/preview/dry-run';
export interface NotifierConfig { url?: string; secret?: string; fetchImpl?: typeof fetch }
export type NotifierResult = { ok: true; data: unknown } | { ok: false; status: number; error: string };

/** Call the Cron Worker's preview endpoints with the shared secret. Errors are reported, never thrown. */
export async function callNotifier(path: NotifierPath, body: unknown, config: NotifierConfig): Promise<NotifierResult> {
  const { url, secret, fetchImpl = fetch } = config;
  if (!url || !secret) return { ok: false, status: 503, error: 'ยังไม่ได้ตั้งค่า NOTIFIER_URL / NOTIFIER_SECRET' };
  let response: Response;
  try {
    response = await fetchImpl(new URL(path, url), {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
    });
  } catch {
    return { ok: false, status: 502, error: 'เชื่อมต่อ Cron Worker ไม่ได้ (ตรวจว่ารันอยู่และ NOTIFIER_URL ถูกต้อง)' };
  }
  if (!response.ok) return { ok: false, status: 502, error: `Cron Worker ตอบกลับผิดปกติ (${response.status})` };
  try {
    return { ok: true, data: await response.json() };
  } catch {
    return { ok: false, status: 502, error: 'Cron Worker ตอบกลับในรูปแบบที่ไม่ถูกต้อง' };
  }
}

export function notifierResponse(result: NotifierResult): Response {
  return result.ok ? json(result.data) : fail(result.error, result.status);
}
```

Create `src/pages/api/preview/test-push.ts`:

```ts
import type { APIRoute } from 'astro';
import { NOTIFIER_URL, NOTIFIER_SECRET } from 'astro:env/server';
import { requireRoot } from '@/lib/auth';
import { callNotifier, notifierResponse } from '@/lib/notifier';

export const prerender = false;

// Sends a fixed test notification to the signed-in root's own devices via the Cron Worker.
export const POST: APIRoute = async ({ locals }) => {
  const denied = await requireRoot(locals);
  if (denied) return denied;
  // The target is the session's user — never taken from the request.
  return notifierResponse(await callNotifier('/preview/test-push', { ownerId: locals.user!.id }, { url: NOTIFIER_URL, secret: NOTIFIER_SECRET }));
};
```

Create `src/pages/api/preview/dry-run.ts`:

```ts
import type { APIRoute } from 'astro';
import { NOTIFIER_URL, NOTIFIER_SECRET } from 'astro:env/server';
import { requireRoot } from '@/lib/auth';
import { callNotifier, notifierResponse } from '@/lib/notifier';

export const prerender = false;

// Lists what the cron would send right now, without sending anything or recording it.
export const POST: APIRoute = async ({ locals }) => {
  const denied = await requireRoot(locals);
  if (denied) return denied;
  return notifierResponse(await callNotifier('/preview/dry-run', {}, { url: NOTIFIER_URL, secret: NOTIFIER_SECRET }));
};
```

Create `src/pages/api/preview/subscriptions.ts`:

```ts
import type { APIRoute } from 'astro';
import { json, dbError } from '@/lib/api';
import { requireRoot } from '@/lib/auth';

export const prerender = false;

// The signed-in root's own registered devices (RLS already limits rows to the owner).
// Only the endpoint's host is returned — never the full endpoint or any encryption key.
export const GET: APIRoute = async ({ locals }) => {
  const denied = await requireRoot(locals);
  if (denied) return denied;
  const { data, error } = await locals.supabase.from('push_subscriptions')
    .select('id, endpoint, created_at').order('created_at', { ascending: false });
  if (error) return dbError(error);
  return json(data.map(row => ({ id: row.id, host: new URL(row.endpoint).hostname, created_at: row.created_at })));
};
```

- [ ] **Step 4: Run tests and typecheck**

```bash
node --experimental-strip-types --test tests/*.test.mjs 2>&1 | grep -E "^✖|ℹ (pass|fail)"
pnpm check 2>&1 | grep -E "error|Result"
```
Expected: `ℹ fail 0`, `0 errors`. (`astro check` resolves `astro:env/server` for the two new env names because Task 6 declared them.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/notifier.ts src/pages/api/preview tests/notifier.test.mjs
git commit -m "feat: root-only /api/preview endpoints calling the Cron Worker" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: `/preview` page, menu, and browser tests

**Files:**
- Create: `src/pages/preview.astro`, `public/preview.js`
- Modify: `src/pages/index.astro` (root-only nav link after the "ผู้ใช้" button)
- Test: `tests/browser/preview.spec.ts` (create)

**Interfaces:**
- Consumes: `/api/preview/*` (Task 7); `data-root-only` nav toggle in `index.astro`.
- Produces: page `/preview` (root only, else redirect `/`); globals `previewTestPush()`, `previewSubscriptions()`, `previewDryRun()`; element ids `btn-test-push`/`out-test-push`, `btn-subs`/`out-subs`, `btn-dry-run`/`out-dry-run`; nav id `nav-preview`.

- [ ] **Step 1: Write the failing browser test**

Create `tests/browser/preview.spec.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

The web dev server (the user's process on :4321) must have loaded the new `.dev.vars`. Check with `curl -s -o /dev/null -w "%{http_code}\n" localhost:4321/` and **ask the user to restart `pnpm dev`** if `NOTIFIER_*` were added after it started (do not kill their server yourself).

Run: `pnpm exec playwright test tests/browser/preview.spec.ts 2>&1 | tail -12`
Expected: the root and layout tests fail (`#nav-preview` not found / `/preview` 404); the non-root test may fail at `#nav-preview`.

- [ ] **Step 3: Implement the page**

Create `src/pages/preview.astro`:

```astro
---
import Layout from '../layouts/Layout.astro';

export const prerender = false;

// Server-side gate: the role is read from the database as the caller, never trusted from the client.
const { data } = await Astro.locals.supabase.from('profiles').select('role').eq('id', Astro.locals.user!.id).maybeSingle();
if (data?.role !== 'root') return Astro.redirect('/');
---

<Layout title="ทดสอบระบบ · RIC Sales CRM">
  <main class="max-w-3xl mx-auto p-4 sm:p-6 space-y-6">
    <div>
      <a href="/" class="inline-flex min-h-11 items-center text-sm text-ric-gray hover:text-ric-black">← กลับ</a>
      <h1 class="text-xl font-semibold mt-1">ทดสอบระบบ</h1>
      <p class="text-ric-gray text-sm mt-0.5">เฉพาะ root · ไม่แตะข้อมูลลูกค้าและไม่ส่งถึงผู้ใช้คนอื่น</p>
    </div>

    <section class="bg-white rounded-xl p-5 shadow-xs border border-gray-100 space-y-3" aria-labelledby="h-push">
      <h2 id="h-push" class="font-semibold text-sm">1. ส่งแจ้งเตือนทดสอบถึงอุปกรณ์ของฉัน</h2>
      <p class="text-xs text-ric-gray">ส่งผ่านระบบส่งจริง (Cron Worker) ไปยังอุปกรณ์ที่คุณเปิดแจ้งเตือนไว้ในหน้าหลัก</p>
      <button id="btn-test-push" type="button" class="btn-primary" onclick="previewTestPush()">ส่งแจ้งเตือนทดสอบ</button>
      <p id="out-test-push" class="text-sm break-words" role="status" aria-live="polite"></p>
    </section>

    <section class="bg-white rounded-xl p-5 shadow-xs border border-gray-100 space-y-3" aria-labelledby="h-subs">
      <h2 id="h-subs" class="font-semibold text-sm">2. ดูสถานะอุปกรณ์ที่สมัครไว้</h2>
      <p class="text-xs text-ric-gray">อุปกรณ์ของคุณที่ระบบรู้จัก และสถานะของเบราว์เซอร์เครื่องนี้</p>
      <button id="btn-subs" type="button" class="btn-primary" onclick="previewSubscriptions()">ตรวจสอบ</button>
      <div id="out-subs" class="text-sm break-words space-y-1" role="status" aria-live="polite"></div>
    </section>

    <section class="bg-white rounded-xl p-5 shadow-xs border border-gray-100 space-y-3" aria-labelledby="h-dry">
      <h2 id="h-dry" class="font-semibold text-sm">3. ถ้า cron รันตอนนี้ จะส่งอะไรบ้าง</h2>
      <p class="text-xs text-ric-gray">แสดงรายการเท่านั้น ไม่ส่งจริงและไม่บันทึกว่าส่งแล้ว</p>
      <button id="btn-dry-run" type="button" class="btn-primary" onclick="previewDryRun()">ดูรายการ</button>
      <div id="out-dry-run" class="text-sm break-words space-y-2" role="status" aria-live="polite"></div>
    </section>
  </main>
  <script is:inline src="/preview.js"></script>
</Layout>
```

Create `public/preview.js` (server data is only ever written with `textContent`):

```js
// Root-only /preview page. Everything from the server is rendered with textContent, never innerHTML.
(() => {
  const el = id => document.getElementById(id);

  function line(text, className = '') {
    const p = document.createElement('p');
    p.textContent = text;
    if (className) p.className = className;
    return p;
  }
  function show(id, ...nodes) { el(id).replaceChildren(...nodes); }
  const say = (id, text, isError = false) => show(id, line(text, isError ? 'text-ric-red' : ''));

  async function call(url, method = 'POST') {
    const response = await fetch(url, { method });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `ผิดพลาด (${response.status})`);
    return data;
  }
  async function busy(buttonId, work) {
    const button = el(buttonId);
    button.disabled = true;
    try { await work(); } finally { button.disabled = false; }
  }

  window.previewTestPush = () => busy('btn-test-push', async () => {
    say('out-test-push', 'กำลังส่ง...');
    try {
      const r = await call('/api/preview/test-push');
      if (!r.devices) return say('out-test-push', 'ยังไม่มีอุปกรณ์ที่สมัครไว้ — เปิดแจ้งเตือนที่เมนูซ้ายของหน้าหลักก่อน', true);
      const extra = (r.failed ? ` · ล้มเหลว ${r.failed}` : '') + (r.pruned ? ` · ลบอุปกรณ์ที่หมดอายุ ${r.pruned}` : '');
      say('out-test-push', `ส่งสำเร็จ ${r.sent} จาก ${r.devices} อุปกรณ์${extra}`, r.sent === 0);
    } catch (error) { say('out-test-push', error.message, true); }
  });

  const PERMISSION = { granted: 'อนุญาตแล้ว', denied: 'ถูกปิดกั้นในเบราว์เซอร์', default: 'ยังไม่ได้ตัดสินใจ' };

  window.previewSubscriptions = () => busy('btn-subs', async () => {
    say('out-subs', 'กำลังตรวจสอบ...');
    try {
      const devices = await call('/api/preview/subscriptions', 'GET');
      const nodes = [];
      nodes.push(line(devices.length ? `อุปกรณ์ที่สมัครไว้ ${devices.length} เครื่อง` : 'ยังไม่มีอุปกรณ์ที่สมัครไว้'));
      for (const d of devices) nodes.push(line(`• ${d.host} · สมัครเมื่อ ${new Date(d.created_at).toLocaleString('th-TH')}`, 'text-xs text-ric-gray'));
      const permission = 'Notification' in window ? PERMISSION[Notification.permission] || Notification.permission : 'เบราว์เซอร์นี้ไม่รองรับ';
      nodes.push(line(`เบราว์เซอร์เครื่องนี้: สิทธิ์แจ้งเตือน ${permission}`, 'text-xs'));
      const registration = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
      nodes.push(line(`Service worker: ${registration ? 'พร้อมใช้งาน' : 'ยังไม่ลงทะเบียน'}`, 'text-xs'));
      show('out-subs', ...nodes);
    } catch (error) { say('out-subs', error.message, true); }
  });

  window.previewDryRun = () => busy('btn-dry-run', async () => {
    say('out-dry-run', 'กำลังคำนวณ...');
    try {
      const r = await call('/api/preview/dry-run');
      const nodes = [line(`เวลาไทยตอนนี้ ${r.now} · ${r.candidates.length ? `จะส่ง ${r.candidates.length} รายการ` : 'ไม่มีรายการที่ต้องส่ง'}`, 'text-xs text-ric-gray')];
      for (const c of r.candidates) {
        const card = document.createElement('div');
        card.className = 'rounded-lg border border-gray-100 p-3 space-y-0.5';
        card.append(line(c.title, 'font-medium'), line(c.body, 'text-xs text-ric-gray'),
          line(c.alreadySent ? 'ส่งแล้ว (จะไม่ส่งซ้ำ)' : 'ยังไม่ได้ส่ง', c.alreadySent ? 'text-xs text-ric-gray' : 'text-xs text-amber-600'));
        nodes.push(card);
      }
      show('out-dry-run', ...nodes);
    } catch (error) { say('out-dry-run', error.message, true); }
  });
})();
```

In `src/pages/index.astro`, immediately after the closing `</button>` of the `nav-users` button (before `</nav>`), add:

```html
    <a href="/preview" class="nav-item w-full text-left hidden" id="nav-preview" data-root-only>
      <svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 3h6m-5 0v6L5 18a2 2 0 001.8 3h10.4a2 2 0 001.8-3l-5-9V3"/></svg>
      ทดสอบระบบ
    </a>
```

- [ ] **Step 4: Run all checks**

```bash
pnpm test 2>&1 | grep -E "^✖|ℹ (pass|fail)"
pnpm check 2>&1 | grep -E "error|Result"
pnpm build 2>&1 | tail -1
pnpm exec playwright test 2>&1 | tail -8
```
Expected: `ℹ fail 0`; `0 errors`; `Complete!`; every Playwright test passes including the four in `preview.spec.ts`. If port 8787 is busy the spec fails with a clear message — ask the user to stop `wrangler dev` and rerun.

- [ ] **Step 5: Commit**

```bash
git add src/pages/preview.astro public/preview.js src/pages/index.astro tests/browser/preview.spec.ts
git commit -m "feat: root-only /preview page with notification test tools" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 9: Docs and full verification

**Files:**
- Modify: `docs/mobile-push-handoff.md`, `README.md`

- [ ] **Step 1: Update the handoff doc**

In `docs/mobile-push-handoff.md`:
- In "สิ่งที่ทำ", replace the Worker bullet's "ส่งเวลา **08:00 น. ประเทศไทย** ทุกวัน: งานครบกำหนด/เลยกำหนด, …" with: `Worker รันทุก 5 นาที: นัดติดตามในแท็บ Log ที่มีเวลาส่งตามเวลานั้น (คลาดไม่เกิน 5 นาที), นัดที่ไม่มีเวลาและใบรับรองใกล้วันตรวจ/วันหมดอายุภายใน 30 วัน (รวมเมื่อเลยกำหนด) ส่งตั้งแต่ 08:00 น. เวลาไทย`.
- Add a new section before "Deploy — ต้องยืนยันก่อน":

```markdown
## ทดสอบการแจ้งเตือนด้วยหน้า /preview (root เท่านั้น)

1. ตั้งค่าครั้งแรก: `node cron-notifications/scripts/setup-notifier.mjs` (สุ่ม `NOTIFIER_SECRET` ใส่ทั้งสอง `.dev.vars` และ `NOTIFIER_URL=http://localhost:8787` ให้เว็บ ไม่พิมพ์ secret) แล้ว restart `pnpm dev`
2. รัน Worker: `pnpm --dir cron-notifications dev`
3. ล็อกอินด้วยบัญชี root → เมนู "ทดสอบระบบ" (หรือไปที่ `/preview`)
4. ปุ่ม 1 ส่งแจ้งเตือนทดสอบถึงอุปกรณ์ตัวเอง (ต้องเปิด 🔔 ในหน้าหลักและอนุญาตในเบราว์เซอร์ก่อน) · ปุ่ม 2 ดูอุปกรณ์ที่สมัครไว้ · ปุ่ม 3 ดูว่า cron จะส่งอะไรถ้ารันตอนนี้ (ไม่ส่งจริง)

`NOTIFIER_SECRET` ต้องเป็นค่าเดียวกันทั้งสองฝั่ง ถ้า Worker ไม่ได้ตั้งค่านี้ ทางเรียก `/preview/*` ของ Worker จะปิด (503)
Playwright spec `tests/browser/preview.spec.ts` เปิด stub ที่พอร์ตของ `NOTIFIER_URL` จึงต้องปิด `wrangler dev` ขณะรัน spec นี้
```
- In the Deploy checklist add: "ตั้ง `NOTIFIER_SECRET` เป็น secret ของทั้งสอง Worker และ `NOTIFIER_URL` ของเว็บเป็นที่อยู่ Worker (แนะนำ service binding แทน URL สาธารณะ), เปลี่ยน cron เป็น `*/5 * * * *` (อยู่ใน `wrangler.toml` แล้ว), apply migration `20260926090000_activities_followup_time.sql`"; and update its "apply migration" line to list the new migration files that exist after the squash (`20260926080000_…`, `20260926090000_…`).

- [ ] **Step 2: README**

In `README.md` add one line under the structure/roles notes: `- หน้า /preview (root เท่านั้น): ปุ่มทดสอบระบบแจ้งเตือน — ดู docs/mobile-push-handoff.md`.

- [ ] **Step 3: Full verification (every command must be green; report any failure by name)**

```bash
cd /Users/iddh/Workspaces/ric-crm
pnpm test 2>&1 | grep -E "^✖|ℹ (pass|fail)"
pnpm --dir cron-notifications run test 2>&1 | grep -E "^✖|ℹ (pass|fail)"
pnpm --dir cron-notifications run check 2>&1 | tail -2
pnpm check 2>&1 | grep -E "error|Result"
pnpm build 2>&1 | tail -1
pnpm exec playwright test 2>&1 | tail -6
cd ../supabase && for t in tests/*.test.sql; do printf "%-42s" $(basename $t); docker exec -i supabase_db_Workspaces psql -U postgres -d postgres -v ON_ERROR_STOP=1 < $t 2>&1 | grep -E "PASSED|ERROR|FAIL" | head -1; done
```
Expected: no `✖`, `ℹ fail 0` twice, clean `tsc`, `0 errors`, build `Complete!`, Playwright all passed, seven SQL lines ending `PASSED`.

- [ ] **Step 4: Confirm no secrets or ignored files are staged, then commit**

```bash
git status --short          # only docs/README should be modified; no .dev.vars, no test-results
git add docs/mobile-push-handoff.md README.md
git commit -m "docs: follow-up time, /preview tools, and NOTIFIER_* setup" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
git log --oneline | head -12
```

- [ ] **Step 5: Manual acceptance (by the user — needs a real browser and device; the agent must not push to real devices)**

Report to the user how to check: (1) `/preview` → "ส่งแจ้งเตือนทดสอบ" shows a notification; (2) add a Log entry with a follow-up 5–10 minutes ahead and watch it arrive within ~5 minutes of that time while `pnpm --dir cron-notifications dev` runs with `--test-scheduled` triggers (`curl "http://localhost:8787/__scheduled"`) — and note that until the real Worker is deployed, local runs only fire when triggered.
