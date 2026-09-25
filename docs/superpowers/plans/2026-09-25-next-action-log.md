# Next-Action Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single mutable `leads.next_action`/`next_action_due` pair with an append-only, per-lead log of next-action line items (each addable, completable, with the Pipeline card automatically picking the most urgent open one).

**Architecture:** A new `next_actions` table (same shape/RLS convention as `activities`) replaces the two dropped `leads` columns. Two new API routes follow the established `parseBody → dbError → json` shape. The lead modal's ข้อมูล tab gets a small list + add-row instead of the two old inputs; the Pipeline card's reminder box is recomputed from the new table instead of reading the old columns directly.

**Tech Stack:** Astro + Cloudflare Workers (ric-crm), Supabase/Postgres + RLS (supabase), Zod, vanilla JS in a single `src/pages/index.astro`.

**Spec:** `docs/superpowers/specs/2026-09-25-next-action-log-design.md`

## Global Constraints

- Two repos: `ric-crm` (this repo) and `supabase` (sibling checkout at `/Users/iddh/Workspaces/supabase`). Tasks say explicitly which repo they touch.
- `supabase db reset` run directly against a shared local Postgres works fine when run from either repo's plain checkout (no git worktree is in play for this plan — verify directly in place, no copy-to-original-checkout dance needed).
- RLS convention for every new table in this app: `select using(true)`; `insert`/`update` `with check (owner_id = (select auth.uid()) or (select public.is_admin()))`; `delete using ((select public.is_root()))`. Copy this verbatim — do not invent a new shape.
- API route shape: `parseBody(request, schema) → early-return Response on failure → dbError(error) on DB failure → json(data, status)`. Every existing route in `src/pages/api/` follows this; match it exactly.
- Line numbers cited in "Modify" steps below were correct when this plan was written but may drift by a few lines once earlier tasks in this same file land — locate the exact block by the quoted surrounding text, not purely by line number.
- Zod helpers already defined in `src/lib/schemas.ts` and reusable as-is: `text(max)`, `optionalText(max)`, `optionalUrl(max)`, `isoDate`, `phone`.
- Commit style: `type: short imperative summary` (e.g. `feat:`, `fix:`), followed by a blank line and a short body if useful, ending with `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` — match `git log` in each repo.

---

### Task 1: `next_actions` table, RLS, and backfill migration

**Files:**
- Create: `supabase/migrations/20260926010000_next_actions.sql` (in the `supabase` repo — the ric-crm repo has no `migrations/` directory)
- Test: manual verification via `supabase db reset`, no automated test in this task (Task 3 adds the SQL test file)

**Interfaces:**
- Produces: table `public.next_actions (id uuid, lead_id uuid, description text, due_date date null, completed_at timestamptz null, owner_id uuid, created_at timestamptz)`, consumed by Tasks 2, 3, 5.
- Produces: `public.leads` loses columns `next_action`, `next_action_due` — any code still referencing them (schemas.ts, seed.sql, index.astro) must be updated in this plan's later tasks or the reset will fail loudly at the `drop column` step if data still depends on them elsewhere. It does not — Task 1's own backfill step runs first.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260926010000_next_actions.sql`:

```sql
-- Next-action log: replaces the single mutable leads.next_action/next_action_due pair with
-- an append-only, per-lead list of line items that can be completed independently. Same
-- shape and RLS convention as activities.
create table public.next_actions (
  id           uuid primary key default gen_random_uuid(),
  lead_id      uuid not null references public.leads (id) on delete cascade,
  description  text not null check (length(btrim(description)) > 0),
  due_date     date null,
  completed_at timestamptz null,
  owner_id     uuid not null default auth.uid() references public.profiles (id),
  created_at   timestamptz not null default now()
);

create index next_actions_lead_id_idx on public.next_actions (lead_id);
create index next_actions_owner_id_idx on public.next_actions (owner_id);

alter table public.next_actions enable row level security;

create policy "next_actions_select" on public.next_actions
  for select to authenticated using (true);
create policy "next_actions_insert" on public.next_actions
  for insert to authenticated with check (owner_id = (select auth.uid()) or (select public.is_admin()));
create policy "next_actions_update" on public.next_actions
  for update to authenticated
  using (owner_id = (select auth.uid()) or (select public.is_admin()))
  with check (owner_id = (select auth.uid()) or (select public.is_admin()));
create policy "next_actions_delete" on public.next_actions
  for delete to authenticated using ((select public.is_root()));

-- Backfill: carry any existing single next_action forward as the first line item, before the
-- columns holding it are dropped below. Filters out blank strings the same way the UI's
-- optionalText treats "" as "not collected".
insert into public.next_actions (lead_id, description, due_date, owner_id)
select id, next_action, next_action_due, owner_id
from public.leads
where next_action is not null and btrim(next_action) <> '';

alter table public.leads
  drop column next_action,
  drop column next_action_due;
```

- [ ] **Step 2: Reset and verify**

Run: `cd /Users/iddh/Workspaces/supabase && supabase db reset`
Expected: the migration step applies cleanly (`Applying migration 20260926010000_next_actions.sql...` with no error), but the run as a whole THEN fails at the seed step — `seed.sql` still does `update public.leads set next_action = ...` against a column this migration just dropped. That seed failure is expected here and is fixed by Task 2, not this one; do not try to make the seed step pass in this task. Confirm the migration itself is correct by inspecting the schema directly:

```bash
docker exec -i supabase_db_Workspaces psql -U postgres -c "\d public.next_actions"
docker exec -i supabase_db_Workspaces psql -U postgres -c "\d public.leads" | grep next_action
```
Expected: the first command shows all 7 columns (`id`, `lead_id`, `description`, `due_date`, `completed_at`, `owner_id`, `created_at`) plus `Policies` listing the 4 RLS policies; the second command prints nothing (columns are gone from `leads`).

- [ ] **Step 3: Commit**

```bash
cd /Users/iddh/Workspaces/supabase
git add migrations/20260926010000_next_actions.sql
git commit -m "feat: next_actions table replaces leads.next_action/next_action_due

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Update seed.sql

**Files:**
- Modify: `supabase/seed.sql:113-117`

**Interfaces:**
- Consumes: `public.next_actions` table from Task 1.

- [ ] **Step 1: Replace the two next_action updates with idempotent inserts**

Current content at `seed.sql:113-117`:

```sql
-- ── next_action on a couple of leads, so the Pipeline card box has something to show ────────
update public.leads set next_action = 'ส่งใบเสนอราคาที่แก้ไขแล้ว', next_action_due = current_date + 2
where id = '11111111-0000-4000-8000-000000000003';
update public.leads set next_action = 'โทรติดตามผลการตัดสินใจ', next_action_due = current_date + 5
where id = '11111111-0000-4000-8000-000000000004';
```

Replace with (fixed ids + `on conflict do nothing`, matching every other block in this file — the old form was flagged as not actually safe to re-run):

```sql
-- ── next_action rows on a couple of leads, so the Pipeline card box has something to show ───
insert into public.next_actions (id, lead_id, description, due_date, owner_id)
select v.id, v.lead_id, v.description, v.due_date, o.id
from (values
  ('66666666-0000-4000-8000-000000000001'::uuid, '11111111-0000-4000-8000-000000000003'::uuid, 'ส่งใบเสนอราคาที่แก้ไขแล้ว', current_date + 2),
  ('66666666-0000-4000-8000-000000000002'::uuid, '11111111-0000-4000-8000-000000000004'::uuid, 'โทรติดตามผลการตัดสินใจ',    current_date + 5)
) as v(id, lead_id, description, due_date)
cross join (select id from public.profiles order by created_at limit 1) as o
on conflict (id) do nothing;
```

- [ ] **Step 2: Reset and verify**

Run: `cd /Users/iddh/Workspaces/supabase && supabase db reset`
Expected: ends with `Finished supabase db reset on branch main.`, no error. Then:

```bash
docker exec -i supabase_db_Workspaces psql -U postgres -c \
  "select lead_id, description, due_date, completed_at from public.next_actions order by lead_id;"
```
Expected: 2 rows, `completed_at` both null, matching the two leads/descriptions above.

Run `supabase db reset` a second time in a row — must still end with `Finished supabase db reset on branch main.` (proves the insert is genuinely idempotent, not just non-erroring once).

- [ ] **Step 3: Commit**

```bash
cd /Users/iddh/Workspaces/supabase
git add seed.sql
git commit -m "fix: seed next_actions via idempotent insert, not a column that no longer exists

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: SQL tests for `next_actions`

**Files:**
- Create: `supabase/tests/next_actions.test.sql`

**Interfaces:**
- Consumes: `public.next_actions` (Task 1), `pg_temp.as_user`/`pg_temp.expect` harness (same pattern as every other test file in this directory — read `supabase/tests/companies_contacts.test.sql` first for the exact harness functions to copy verbatim).

- [ ] **Step 1: Write the test file**

Create `supabase/tests/next_actions.test.sql`:

```sql
-- supabase/tests/next_actions.test.sql
-- Run: docker exec -i supabase_db_Workspaces psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/next_actions.test.sql
begin;

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                        confirmation_token, recovery_token, email_change, email_change_token_new)
select '00000000-0000-0000-0000-000000000000', v.id, 'authenticated', 'authenticated', v.email, '', now(),
       '{}', '{}', now(), now(), '', '', '', ''
from (values
  ('dddddddd-1000-4000-8000-00000000000a'::uuid, 'test-admin3@example.test'),
  ('dddddddd-1000-4000-8000-00000000000b'::uuid, 'test-sales5@example.test'),
  ('dddddddd-1000-4000-8000-00000000000c'::uuid, 'test-sales6@example.test'),
  ('dddddddd-1000-4000-8000-00000000000d'::uuid, 'test-root3@example.test')
) as v(id, email);

update public.profiles set role = 'admin' where id = 'dddddddd-1000-4000-8000-00000000000a';
update public.profiles set role = 'root'  where id = 'dddddddd-1000-4000-8000-00000000000d';

insert into public.companies (id, name, owner_id) values
  ('dddddddd-1000-4000-8000-00000000001a', 'test co for next_actions', 'dddddddd-1000-4000-8000-00000000000b');

insert into public.leads (id, company_id, stage, value, notes, owner_id) values
  ('dddddddd-1000-4000-8000-00000000002a', 'dddddddd-1000-4000-8000-00000000001a', 'new', 0, '', 'dddddddd-1000-4000-8000-00000000000b');

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

\set admin  '''dddddddd-1000-4000-8000-00000000000a'''
\set sales1 '''dddddddd-1000-4000-8000-00000000000b'''
\set sales2 '''dddddddd-1000-4000-8000-00000000000c'''
\set root   '''dddddddd-1000-4000-8000-00000000000d'''
\set lead   '''dddddddd-1000-4000-8000-00000000002a'''

select pg_temp.expect('sales1 adds a next_action on their own lead (becomes owner)',
  pg_temp.as_user(:sales1, $$insert into public.next_actions (lead_id, description, owner_id) values ('dddddddd-1000-4000-8000-00000000002a', 'ส่งใบเสนอราคา', 'dddddddd-1000-4000-8000-00000000000b')$$), 'ok:1');

select pg_temp.expect('sales2 cannot insert a next_action owned by someone else',
  pg_temp.as_user(:sales2, $$insert into public.next_actions (lead_id, description, owner_id) values ('dddddddd-1000-4000-8000-00000000002a', 'forged', 'dddddddd-1000-4000-8000-00000000000b')$$), 'error:%row-level security%');

select pg_temp.expect('everyone sees the next_action',
  pg_temp.as_user(:sales2, $$select 1 from public.next_actions where lead_id = 'dddddddd-1000-4000-8000-00000000002a' having count(*) = 1$$), 'ok:1');

select pg_temp.expect('sales2 cannot complete sales1''s next_action',
  pg_temp.as_user(:sales2, $$update public.next_actions set completed_at = now() where lead_id = 'dddddddd-1000-4000-8000-00000000002a'$$), 'ok:0');

select pg_temp.expect('sales1 completes their own next_action',
  pg_temp.as_user(:sales1, $$update public.next_actions set completed_at = now() where lead_id = 'dddddddd-1000-4000-8000-00000000002a'$$), 'ok:1');

select pg_temp.expect('admin edits any next_action (uncompletes it)',
  pg_temp.as_user(:admin, $$update public.next_actions set completed_at = null where lead_id = 'dddddddd-1000-4000-8000-00000000002a'$$), 'ok:1');

select pg_temp.expect('sales1 cannot delete a next_action',
  pg_temp.as_user(:sales1, $$delete from public.next_actions where lead_id = 'dddddddd-1000-4000-8000-00000000002a'$$), 'ok:0');
select pg_temp.expect('admin cannot delete a next_action',
  pg_temp.as_user(:admin, $$delete from public.next_actions where lead_id = 'dddddddd-1000-4000-8000-00000000002a'$$), 'ok:0');
select pg_temp.expect('root deletes a next_action',
  pg_temp.as_user(:root, $$delete from public.next_actions where lead_id = 'dddddddd-1000-4000-8000-00000000002a'$$), 'ok:1');

select pg_temp.expect('cascade: deleting the lead removes its next_actions too',
  pg_temp.as_user(:sales1, $$insert into public.next_actions (lead_id, description, owner_id) values ('dddddddd-1000-4000-8000-00000000002a', 'will cascade', 'dddddddd-1000-4000-8000-00000000000b')$$), 'ok:1');
select pg_temp.expect('root deletes the lead',
  pg_temp.as_user(:root, $$delete from public.leads where id = 'dddddddd-1000-4000-8000-00000000002a'$$), 'ok:1');
select pg_temp.expect('the cascaded next_action is gone',
  pg_temp.as_user(:root, $$select 1 from public.next_actions where lead_id = 'dddddddd-1000-4000-8000-00000000002a' having count(*) = 0$$), 'ok:1');

do $$ begin raise notice 'ALL NEXT_ACTIONS TESTS PASSED'; end $$;

rollback;
```

- [ ] **Step 2: Run it against the live local DB**

Run:
```bash
cd /Users/iddh/Workspaces/supabase
docker exec -i supabase_db_Workspaces psql -U postgres -v ON_ERROR_STOP=1 -f - < tests/next_actions.test.sql
```
Expected: 11 `pass` NOTICEs, then `ALL NEXT_ACTIONS TESTS PASSED`, then `ROLLBACK`. No `FAIL` or `ERROR`.

- [ ] **Step 3: Commit**

```bash
cd /Users/iddh/Workspaces/supabase
git add tests/next_actions.test.sql
git commit -m "test: cover next_actions RLS matrix and lead cascade-delete

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Zod schemas

**Files:**
- Modify: `src/lib/schemas.ts` (ric-crm repo)

**Interfaces:**
- Consumes: `text`, `optionalText`, `isoDate` helpers already defined at the top of this file.
- Produces: `nextActionCreate`, `nextActionUpdate` — consumed by Task 5's API routes.

- [ ] **Step 1: Remove `next_action`/`next_action_due` from the lead schemas**

Current content (`src/lib/schemas.ts:12-35`):

```typescript
export const leadInput = z.object({
  company_id: z.uuid(),
  primary_contact_id: z.union([z.null(), z.uuid()]).optional(),
  cert: z.array(text(100)).max(10).default([]),
  stage: z.enum(['new', 'contacted', 'quoted', 'negotiating', 'won', 'lost']),
  value: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  notes: text(5000),
  quote_link: optionalUrl(500),
  next_action: optionalText(200),
  next_action_due: z.union([z.null(), isoDate]).optional(),
  owner_id: z.uuid(),
});
export const leadCreate = leadInput.partial({
  primary_contact_id: true,
  cert: true,
  stage: true,
  value: true,
  notes: true,
  quote_link: true,
  next_action: true,
  next_action_due: true,
  owner_id: true,
});
export const leadUpdate = leadInput.partial();
```

Replace with:

```typescript
export const leadInput = z.object({
  company_id: z.uuid(),
  primary_contact_id: z.union([z.null(), z.uuid()]).optional(),
  cert: z.array(text(100)).max(10).default([]),
  stage: z.enum(['new', 'contacted', 'quoted', 'negotiating', 'won', 'lost']),
  value: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  notes: text(5000),
  quote_link: optionalUrl(500),
  owner_id: z.uuid(),
});
export const leadCreate = leadInput.partial({
  primary_contact_id: true,
  cert: true,
  stage: true,
  value: true,
  notes: true,
  quote_link: true,
  owner_id: true,
});
export const leadUpdate = leadInput.partial();

// Next-action log: multiple line items per lead (replaces the old single next_action /
// next_action_due columns). "completed" is a boolean on the wire; the API route translates
// it to a server-set completed_at timestamp rather than trusting a client-supplied one.
export const nextActionCreate = z.object({
  lead_id: z.uuid(),
  description: text(200).min(1),
  due_date: z.union([z.null(), isoDate]).optional(),
  owner_id: z.uuid().optional(),
});
export const nextActionUpdate = z.object({
  description: text(200).min(1).optional(),
  due_date: z.union([z.null(), isoDate]).optional(),
  completed: z.boolean().optional(),
});
```

- [ ] **Step 2: Verify**

Run: `pnpm check`
Expected: `0 errors`. (There will be pre-existing hint-level output unrelated to this change — only errors/warnings matter here.)

- [ ] **Step 3: Commit**

```bash
git add src/lib/schemas.ts
git commit -m "feat: nextActionCreate/nextActionUpdate schemas; drop next_action from leadInput

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: API routes

**Files:**
- Create: `src/pages/api/next-actions.ts`
- Create: `src/pages/api/next-actions/[id].ts`

**Interfaces:**
- Consumes: `nextActionCreate`/`nextActionUpdate` (Task 4), `json`/`fail`/`parseBody`/`dbError` from `@/lib/api`, `requireRoot` from `@/lib/auth`, `uuidParam` from `@/lib/schemas`.
- Produces: `GET /api/next-actions` (optional `?lead_id=`), `POST /api/next-actions`, `PUT /api/next-actions/:id`, `DELETE /api/next-actions/:id` (root-only) — consumed by Task 6's UI.

- [ ] **Step 1: `src/pages/api/next-actions.ts`**

```typescript
import type { APIRoute } from 'astro';
import { json, fail, parseBody, dbError } from '@/lib/api';
import { nextActionCreate, uuidParam } from '@/lib/schemas';

export const prerender = false;

export const GET: APIRoute = async ({ locals, url }) => {
  let query = locals.supabase.from('next_actions').select('*').order('due_date', { ascending: true, nullsFirst: false });
  const leadId = url.searchParams.get('lead_id');
  if (leadId) {
    const parsed = uuidParam.safeParse(leadId);
    if (!parsed.success) return fail('Invalid lead_id', 400);
    query = query.eq('lead_id', parsed.data);
  }
  const { data, error } = await query;
  if (error) return dbError(error);
  return json(data);
};

export const POST: APIRoute = async ({ locals, request }) => {
  const body = await parseBody(request, nextActionCreate);
  if (body instanceof Response) return body;

  const { data, error } = await locals.supabase.from('next_actions').insert(body).select('*').single();
  if (error) return dbError(error);
  return json(data, 201);
};
```

- [ ] **Step 2: `src/pages/api/next-actions/[id].ts`**

```typescript
import type { APIRoute } from 'astro';
import { json, fail, parseBody, dbError } from '@/lib/api';
import { requireRoot } from '@/lib/auth';
import { nextActionUpdate, uuidParam } from '@/lib/schemas';

export const prerender = false;

export const PUT: APIRoute = async ({ locals, request, params }) => {
  const id = uuidParam.safeParse(params.id);
  if (!id.success) return fail('Invalid id', 400);

  const body = await parseBody(request, nextActionUpdate);
  if (body instanceof Response) return body;
  if (Object.keys(body).length === 0) return fail('Nothing to update', 400);

  // "completed" is a boolean on the wire; translate to a server-set timestamp so the client
  // can never forge a specific completion time.
  const { completed, ...rest } = body;
  const update = { ...rest, ...(completed !== undefined && { completed_at: completed ? new Date().toISOString() : null }) };

  const { data, error } = await locals.supabase.from('next_actions').update(update).eq('id', id.data).select('id');
  if (error) return dbError(error);
  if (data.length === 0) return fail('Not found', 404);
  return json({ ok: true });
};

export const DELETE: APIRoute = async ({ locals, params }) => {
  // RLS only lets root delete, but answer 403 (not a misleading 404) for everyone else.
  const denied = await requireRoot(locals);
  if (denied) return denied;

  const id = uuidParam.safeParse(params.id);
  if (!id.success) return fail('Invalid id', 400);

  const { data, error } = await locals.supabase.from('next_actions').delete().eq('id', id.data).select('id');
  if (error) return dbError(error);
  if (data.length === 0) return fail('Not found', 404);
  return json({ ok: true });
};
```

- [ ] **Step 3: Verify**

Run: `pnpm check`
Expected: `0 errors`.

- [ ] **Step 4: Commit**

```bash
git add src/pages/api/next-actions.ts src/pages/api/next-actions/\[id\].ts
git commit -m "feat: next-actions API routes (GET/POST, PUT/DELETE)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Lead modal UI — line-item list + add-row

**Files:**
- Modify: `src/pages/index.astro` (markup around the current `lead-next-action`/`lead-next-action-due` inputs; JS state near `let currentLeadId`; `loadAll()`; `openLeadModal()`; `saveLead()`; a new block of functions near `renderLeadLog()`)

**Interfaces:**
- Consumes: `/api/next-actions` (Task 5), `esc()`, `nullableInput()`, `api()`, `currentLeadId`, `renderAll()` — all already defined elsewhere in this file.
- Produces: global array `nextActions`, functions `renderLeadNextActions()`, `addNextAction()`, `toggleNextActionDone(id, checked)` — consumed by Task 7.

- [ ] **Step 1: Replace the two old form fields with the new section**

Current content (`src/pages/index.astro`, inside the lead form's field grid):

```astro
        <div>
          <label class="field-label">งานถัดไป</label>
          <input class="field-input" id="lead-next-action" placeholder="เช่น ส่งใบเสนอราคา, โทรติดตาม" />
        </div>
        <div>
          <label class="field-label">วันครบกำหนด</label>
          <input class="field-input" id="lead-next-action-due" type="date" />
        </div>
```

Replace with (spans both grid columns, like the cert-checkboxes block above it — only shown once the lead exists, since a line item needs a real `lead_id`):

```astro
        <div class="col-span-2 hidden" id="lead-next-actions-section">
          <label class="field-label">งานถัดไป</label>
          <div id="lead-next-actions-list" class="space-y-1.5 mb-2"></div>
          <div class="flex gap-2">
            <input class="field-input flex-1" id="next-action-new-description" placeholder="เช่น ส่งใบเสนอราคา, โทรติดตาม" />
            <input class="field-input w-36" id="next-action-new-due" type="date" />
            <button type="button" id="next-action-add-btn" onclick="addNextAction()" class="btn-secondary shrink-0">+ เพิ่ม</button>
          </div>
        </div>
```

- [ ] **Step 2: Add the `nextActions` state array**

Find the `let currentCompanyId = null;` / `let companyEditMode = false;` state declarations near the top of the `<script>` block and add alongside the other loaded-list arrays (`let activities = [];` etc — locate that exact line and add immediately after it):

```javascript
let nextActions = [];
```

- [ ] **Step 3: Load it in `loadAll()`**

Current content (`src/pages/index.astro`, `loadAll()`):

```javascript
async function loadAll() {
  const [l, a, r, co, ct, who] = await Promise.all([
    api('/api/leads'),
    api('/api/activities'),
    api('/api/renewals'),
    api('/api/companies'),
    api('/api/contacts'),
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
  renderAll();
}
```

Replace with:

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
  nextActions = na;
  renderAll();
}
```

- [ ] **Step 4: Wire `openLeadModal()`**

Current content (`src/pages/index.astro`, `openLeadModal`):

```javascript
async function openLeadModal(id = null) {
  const modal = document.getElementById('modal-lead');
  const deleteBtn = document.getElementById('lead-delete-btn');
  let editable = true;
  currentLeadId = id;
  switchLeadTab('info');
  document.getElementById('lead-tab-btn-log').classList.toggle('hidden', !id);

  if (id) {
    const lead = leads.find(l => l.id === id);
    if (!lead) return;
    document.getElementById('lead-modal-title').textContent = 'แก้ไขลีด';
    document.getElementById('lead-id').value = lead.id;
    populateCompanySelect(lead.company_id);
    populateContactSelect(lead.company_id, lead.primary_contact_id || '');
    setCertCheckboxes(lead.cert || []);
    document.getElementById('lead-stage').value = lead.stage || 'new';
    document.getElementById('lead-value').value = lead.value || '';
    document.getElementById('lead-quote-link').value = lead.quote_link || '';
    document.getElementById('lead-next-action').value = lead.next_action || '';
    document.getElementById('lead-next-action-due').value = lead.next_action_due || '';
    onStageChange();
    document.getElementById('lead-owner').value = lead.owner_id;
    document.getElementById('lead-notes').value = lead.notes || '';
    deleteBtn.classList.toggle('hidden', !isRoot());
    editable = canEdit(lead);
    if (!editable) document.getElementById('lead-modal-title').textContent = 'ดูลีด (แก้ไขได้เฉพาะเจ้าของ)';
  } else {
    document.getElementById('lead-modal-title').textContent = 'เพิ่มลีดใหม่';
    document.getElementById('lead-form').reset();
    document.getElementById('lead-id').value = '';
    document.getElementById('lead-owner').value = me.id;
    onStageChange();
    populateCompanySelect('');
    deleteBtn.classList.add('hidden');
  }

  document.querySelectorAll('#lead-form input:not([type=hidden]), #lead-form select, #lead-form textarea')
    .forEach(el => { el.disabled = !editable; });
  document.getElementById('lead-submit-btn').classList.toggle('hidden', !editable);

  modal.classList.remove('hidden');
}
```

Replace with (removes the two old-field population lines, shows/renders the new section only when editing an existing lead, and separately hides the "+ เพิ่ม" button when read-only since it's a `<button>` outside the disabled-sweep's input/select/textarea selector):

```javascript
async function openLeadModal(id = null) {
  const modal = document.getElementById('modal-lead');
  const deleteBtn = document.getElementById('lead-delete-btn');
  let editable = true;
  currentLeadId = id;
  switchLeadTab('info');
  document.getElementById('lead-tab-btn-log').classList.toggle('hidden', !id);
  document.getElementById('lead-next-actions-section').classList.toggle('hidden', !id);

  if (id) {
    const lead = leads.find(l => l.id === id);
    if (!lead) return;
    document.getElementById('lead-modal-title').textContent = 'แก้ไขลีด';
    document.getElementById('lead-id').value = lead.id;
    populateCompanySelect(lead.company_id);
    populateContactSelect(lead.company_id, lead.primary_contact_id || '');
    setCertCheckboxes(lead.cert || []);
    document.getElementById('lead-stage').value = lead.stage || 'new';
    document.getElementById('lead-value').value = lead.value || '';
    document.getElementById('lead-quote-link').value = lead.quote_link || '';
    onStageChange();
    document.getElementById('lead-owner').value = lead.owner_id;
    document.getElementById('lead-notes').value = lead.notes || '';
    deleteBtn.classList.toggle('hidden', !isRoot());
    editable = canEdit(lead);
    if (!editable) document.getElementById('lead-modal-title').textContent = 'ดูลีด (แก้ไขได้เฉพาะเจ้าของ)';
    renderLeadNextActions();
  } else {
    document.getElementById('lead-modal-title').textContent = 'เพิ่มลีดใหม่';
    document.getElementById('lead-form').reset();
    document.getElementById('lead-id').value = '';
    document.getElementById('lead-owner').value = me.id;
    onStageChange();
    populateCompanySelect('');
    deleteBtn.classList.add('hidden');
  }

  document.querySelectorAll('#lead-form input:not([type=hidden]), #lead-form select, #lead-form textarea')
    .forEach(el => { el.disabled = !editable; });
  document.getElementById('lead-submit-btn').classList.toggle('hidden', !editable);
  document.getElementById('next-action-add-btn').classList.toggle('hidden', !editable);

  modal.classList.remove('hidden');
}
```

- [ ] **Step 5: Remove the two fields from `saveLead()`'s payload**

Current content (`src/pages/index.astro`, inside `saveLead`):

```javascript
  const data = {
    company_id: companyId,
    primary_contact_id: contactId || null,
    cert: getCertCheckboxes(),
    stage: document.getElementById('lead-stage').value,
    value: parseInt(document.getElementById('lead-value').value) || 0,
    // Only meaningful for the "เสนอราคา" stage, but harmless to keep if the stage changes later.
    quote_link: nullableInput('lead-quote-link'),
    next_action: nullableInput('lead-next-action'),
    next_action_due: nullableInput('lead-next-action-due'),
    notes: document.getElementById('lead-notes').value,
    ...ownerField('lead-owner'),
  };
```

Replace with:

```javascript
  const data = {
    company_id: companyId,
    primary_contact_id: contactId || null,
    cert: getCertCheckboxes(),
    stage: document.getElementById('lead-stage').value,
    value: parseInt(document.getElementById('lead-value').value) || 0,
    // Only meaningful for the "เสนอราคา" stage, but harmless to keep if the stage changes later.
    quote_link: nullableInput('lead-quote-link'),
    notes: document.getElementById('lead-notes').value,
    ...ownerField('lead-owner'),
  };
```

- [ ] **Step 6: Add the render/add/toggle functions**

Find `function renderLeadLog() {` in `src/pages/index.astro` and insert the following three functions immediately **before** it (so they sit alongside the rest of the lead-modal-support functions):

```javascript
function renderLeadNextActions() {
  const items = nextActions
    .filter(n => n.lead_id === currentLeadId)
    .sort((a, b) => {
      if (!!a.completed_at !== !!b.completed_at) return a.completed_at ? 1 : -1;
      if (a.completed_at && b.completed_at) return new Date(b.completed_at) - new Date(a.completed_at);
      if (!a.due_date && !b.due_date) return 0;
      if (!a.due_date) return 1;
      if (!b.due_date) return -1;
      return new Date(a.due_date) - new Date(b.due_date);
    });
  document.getElementById('lead-next-actions-list').innerHTML = items.length
    ? items.map(n => {
        const dueLabel = n.due_date
          ? new Date(n.due_date).toLocaleDateString('th-TH', { day: 'numeric', month: 'short' })
          : '';
        return `<label class="flex items-center gap-2 text-sm ${n.completed_at ? 'text-ric-gray line-through' : ''}">
          <input type="checkbox" ${n.completed_at ? 'checked' : ''} onchange="toggleNextActionDone('${esc(n.id)}', this.checked)" class="rounded-sm border-gray-300 text-ric-red focus:ring-ric-red" />
          <span class="flex-1">${esc(n.description)}</span>
          ${dueLabel ? `<span class="text-xs text-ric-gray shrink-0">${dueLabel}</span>` : ''}
        </label>`;
      }).join('')
    : '<p class="text-xs text-ric-gray">ยังไม่มีงานถัดไป</p>';
}

async function addNextAction() {
  const description = document.getElementById('next-action-new-description').value.trim();
  if (!description) return;
  const data = {
    lead_id: currentLeadId,
    description,
    due_date: nullableInput('next-action-new-due'),
  };
  try {
    await api('/api/next-actions', { method: 'POST', body: JSON.stringify(data) });
    nextActions = await api('/api/next-actions');
  } catch (err) {
    alert('เพิ่มไม่สำเร็จ: ' + err.message);
    return;
  }
  document.getElementById('next-action-new-description').value = '';
  document.getElementById('next-action-new-due').value = '';
  renderLeadNextActions();
  renderAll();
}

async function toggleNextActionDone(id, checked) {
  try {
    await api(`/api/next-actions/${id}`, { method: 'PUT', body: JSON.stringify({ completed: checked }) });
    nextActions = await api('/api/next-actions');
  } catch (err) {
    alert('บันทึกไม่สำเร็จ: ' + err.message);
    return;
  }
  renderLeadNextActions();
  renderAll();
}

```

- [ ] **Step 7: Verify**

Run: `node --check` on the extracted inline script (see below), then `pnpm check` and `pnpm build`.

```bash
node -e "
const fs = require('fs');
const src = fs.readFileSync('src/pages/index.astro', 'utf8');
const start = src.indexOf('<script is:inline>') + '<script is:inline>'.length;
const end = src.indexOf('</script>', start);
fs.writeFileSync('/tmp/extracted-check.js', src.slice(start, end));
"
node --check /tmp/extracted-check.js
pnpm check
pnpm build
```
Expected: `syntax OK` implied by no output from `node --check`; `pnpm check` reports `0 errors, 0 warnings`; `pnpm build` ends with `[build] Complete!`.

- [ ] **Step 8: Commit**

```bash
git add src/pages/index.astro
git commit -m "feat: lead modal — next-action line items replace the single overwritable field

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: Pipeline card reminder

**Files:**
- Modify: `src/pages/index.astro` (`renderLeadCard`)

**Interfaces:**
- Consumes: `nextActions` global (Task 6), `daysUntil()`, `esc()` — all already defined in this file.

- [ ] **Step 1: Replace the reminder computation**

Current content (`src/pages/index.astro`, `renderLeadCard`):

```javascript
function renderLeadCard(l) {
  const overdue = l.next_action_due && daysUntil(l.next_action_due) < 0;
  const dueLabel = l.next_action_due
    ? new Date(l.next_action_due).toLocaleDateString('th-TH', { day: 'numeric', month: 'short' })
    : '';
  const nextActionHtml = l.next_action
    ? `<p class="text-[11px] mt-2 px-2 py-1 rounded-md ${overdue ? 'bg-red-50 text-ric-red' : 'bg-amber-50 text-amber-700'}">🔔 ${esc(l.next_action)}${dueLabel ? ` — ${overdue ? 'เลยกำหนด' : 'ครบกำหนด'} ${dueLabel}` : ''}</p>`
    : '';
```

Replace with:

```javascript
function renderLeadCard(l) {
  // Pick the open (not completed) next_action with the nearest due date — nulls-due-date sort
  // last, since an undated item is less urgent than any dated one.
  const openActions = nextActions
    .filter(n => n.lead_id === l.id && !n.completed_at)
    .sort((a, b) => {
      if (!a.due_date && !b.due_date) return 0;
      if (!a.due_date) return 1;
      if (!b.due_date) return -1;
      return new Date(a.due_date) - new Date(b.due_date);
    });
  const picked = openActions[0];
  const overdue = picked?.due_date && daysUntil(picked.due_date) < 0;
  const dueLabel = picked?.due_date
    ? new Date(picked.due_date).toLocaleDateString('th-TH', { day: 'numeric', month: 'short' })
    : '';
  const nextActionHtml = picked
    ? `<p class="text-[11px] mt-2 px-2 py-1 rounded-md ${overdue ? 'bg-red-50 text-ric-red' : 'bg-amber-50 text-amber-700'}">🔔 ${esc(picked.description)}${dueLabel ? ` — ${overdue ? 'เลยกำหนด' : 'ครบกำหนด'} ${dueLabel}` : ''}</p>`
    : '';
```

The rest of `renderLeadCard` (the `return` block using `nextActionHtml`) is unchanged.

- [ ] **Step 2: Verify**

Run: `pnpm check && pnpm build`
Expected: `0 errors, 0 warnings`; build ends with `[build] Complete!`.

- [ ] **Step 3: Commit**

```bash
git add src/pages/index.astro
git commit -m "feat: Pipeline card picks nearest-due open next_action from the new log

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: End-to-end verification

**Files:** none.

- [ ] **Step 1: Clean reset**

```bash
cd /Users/iddh/Workspaces/supabase && supabase db reset
```
Expected: ends with `Finished supabase db reset on branch main.`, no error.

- [ ] **Step 2: Start (or confirm) the dev server**

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

LEAD=$(curl -s -b "$JAR" $B/api/leads | python3 -c "import json,sys;print(json.load(sys.stdin)[0]['id'])")

echo "-- create two next_actions on the same lead with different due dates --"
A1=$(curl -s -b "$JAR" -H "$H" -H 'content-type: application/json' -X POST $B/api/next-actions -d "{\"lead_id\":\"$LEAD\",\"description\":\"งานไกล\",\"due_date\":\"2027-01-01\"}")
A2=$(curl -s -b "$JAR" -H "$H" -H 'content-type: application/json' -X POST $B/api/next-actions -d "{\"lead_id\":\"$LEAD\",\"description\":\"งานใกล้\",\"due_date\":\"2026-10-01\"}")
A1_ID=$(echo "$A1" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
A2_ID=$(echo "$A2" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

echo "-- GET filtered by lead_id returns exactly these two, sorted nearest-due first --"
curl -s -b "$JAR" "$B/api/next-actions?lead_id=$LEAD" | python3 -c "
import json, sys
rows = json.load(sys.stdin)
assert len(rows) == 2, rows
assert rows[0]['description'] == 'งานใกล้', rows
assert rows[1]['description'] == 'งานไกล', rows
print('ok: sorted nearest-due first')
"

echo "-- complete the nearer one --"
curl -s -b "$JAR" -H "$H" -H 'content-type: application/json' -w " [%{http_code}]\n" -X PUT $B/api/next-actions/$A2_ID -d '{"completed":true}'
curl -s -b "$JAR" "$B/api/next-actions?lead_id=$LEAD" | python3 -c "
import json, sys
rows = json.load(sys.stdin)
done = next(r for r in rows if r['id'] == '$A2_ID')
assert done['completed_at'] is not None, done
print('ok: completed_at set')
"

echo "-- uncomplete it --"
curl -s -b "$JAR" -H "$H" -H 'content-type: application/json' -X PUT $B/api/next-actions/$A2_ID -d '{"completed":false}' -o /dev/null

echo "-- non-root cannot delete (expect root CAN, since we're logged in as root here — verify the route exists and works) --"
curl -s -b "$JAR" -H "$H" -w " [%{http_code}]\n" -X DELETE $B/api/next-actions/$A1_ID
curl -s -b "$JAR" -H "$H" -w " [%{http_code}]\n" -X DELETE $B/api/next-actions/$A2_ID

echo "-- confirm leads no longer carry next_action/next_action_due columns --"
curl -s -b "$JAR" $B/api/leads | python3 -c "
import json, sys
rows = json.load(sys.stdin)
assert 'next_action' not in rows[0], rows[0]
assert 'next_action_due' not in rows[0], rows[0]
print('ok: old columns gone from API response')
"
```
Expected: every step prints its `ok:` line with no assertion error; both DELETEs return `[200]` (logged in as root).

- [ ] **Step 4: Build**

Run: `pnpm build`
Expected: ends with `[build] Complete!`.

- [ ] **Step 5: Rendered-page markup check**

```bash
curl -s -b "$JAR" $B/ -o /tmp/next-actions-page.html
python3 -c "
content = open('/tmp/next-actions-page.html').read()
checks = {
  'next-actions section': 'id=\"lead-next-actions-section\"',
  'next-actions list': 'id=\"lead-next-actions-list\"',
  'add button': 'id=\"next-action-add-btn\"',
  'renderLeadNextActions fn': 'function renderLeadNextActions',
  'addNextAction fn': 'function addNextAction',
  'toggleNextActionDone fn': 'function toggleNextActionDone',
  'old field gone': 'id=\"lead-next-action\"',
  'old date field gone': 'id=\"lead-next-action-due\"',
}
for label, needle in checks.items():
    print(f'{content.count(needle):>3}  {label}')
"
```
Expected: every row except the two "gone" checks shows `1`; both "gone" checks show `0`.

- [ ] **Step 6: No commit** — this task makes no source changes.

## Known limitations (explicitly not built)

- No inline edit of an existing next-action's text/date — only add-new and mark-done/undone, per the spec's explicit out-of-scope note. A wrong entry is either left as-is or marked done; only root can delete it, and no delete button exists in the UI yet (the API route is there for future use).
- No notifications — the 🔔 box on the Pipeline card is the only surface that reflects an open next-action.
- Tie-breaking when two open items share the same due date is whatever the DB/array's stable sort happens to produce — not specified, not worth specifying at this scale.
